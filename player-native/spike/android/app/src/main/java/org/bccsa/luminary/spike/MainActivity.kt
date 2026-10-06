package org.bccsa.luminary.spike

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.annotation.OptIn
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import kotlin.math.roundToLong
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.bccsa.luminary.player.engine.FullscreenPresenter

/**
 * Step 0, laid out like the iOS spike: the picture with its overlay controls, the mode, a button
 * per visit, and the log.
 *
 * `adb shell am start -n org.bccsa.luminary.spike/.MainActivity --ez autorun true` runs step 0
 * unattended; `adb logcat -s LmcSpike` collects it.
 */
class MainActivity : ComponentActivity(), Transport {
    private val main = Handler(Looper.getMainLooper())
    private val scope = MainScope()
    private lateinit var spike: SpikePlayer
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var playerView: PlayerView
    private lateinit var controls: TransportControls
    private val presenter = FullscreenPresenter { this }
    private val buttons = mutableListOf<View>()
    private val tick = object : Runnable {
        override fun run() {
            val player = spike.player
            val duration = player.duration.takeIf { it != C.TIME_UNSET }?.div(1000.0)
            controls.update(player.playWhenReady, player.currentPosition / 1000.0, duration, player.bufferedPosition / 1000.0)
            main.postDelayed(this, 250)
        }
    }

    private fun log(line: String) {
        val stamped = "[spike] $line"
        Log.i(SpikeApp.TAG, stamped)
        main.post {
            logView.append(stamped + "\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

    @OptIn(UnstableApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.WHITE)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left + dp(12), bars.top + dp(12), bars.right + dp(12), bars.bottom)
            insets
        }
        logView = logView()
        logScroll = ScrollView(this).apply { addView(logView) }

        val payload = runCatching { Payload.bundled(this) }.onFailure { log("payload: ${it.message}") }.getOrNull()
        if (payload == null) {
            log("payload: none bundled; run `python3 make-sample-stream.py` (or `node make-payload.mjs --android <masterUrl> <keyHex>`) in player-native/spike, then rebuild")
        }
        (application as SpikeApp).server?.let { log("server  bundled stream on http://127.0.0.1:${LocalStreamServer.PORT}") }
        spike = SpikePlayer(this, payload, ::log)

        // The picture, with AVPlayerViewController's controls over it.
        playerView = PlayerView(this).apply {
            useController = false
            player = spike.player
            setShutterBackgroundColor(Color.BLACK)
        }
        controls = TransportControls(this, this)
        val frame = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(playerView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
            addView(controls, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        val width = resources.displayMetrics.widthPixels - dp(24)
        root.addView(frame, LinearLayout.LayoutParams(MATCH_PARENT, width * 9 / 16))

        val modes = SegmentedControl(this, SpikePlayer.Mode.entries.map { it.label }, spike.mode.ordinal) {
            spike.mode = SpikePlayer.Mode.entries[it]
        }
        root.addView(modes, LinearLayout.LayoutParams(MATCH_PARENT, dp(46)).apply { topMargin = dp(12) })

        val visits = CapsuleRow(this)
        visits.set(payload?.visits?.mapIndexed { index, visit ->
            capsuleButton(payload.name(visit)) {
                if (index == 0) spike.reset()
                spike.play(visit, if (index == 0) 0 else spike.player.currentPosition)
            }.also(buttons::add)
        }.orEmpty())
        root.addView(visits, LinearLayout.LayoutParams(MATCH_PARENT, dp(56)).apply { topMargin = dp(6) })

        val tools = CapsuleRow(this)
        tools.set(listOfNotNull(
            payload?.let { capsuleButton("Autorun") { autorun() }.also(buttons::add) },
            capsuleButton("Stats") { spike.dumpStats("manual") },
            capsuleButton("Bridge →") { startActivity(Intent(this, BridgeActivity::class.java)) },
        ))
        root.addView(tools)

        root.addView(logScroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)
        window.decorView.keepScreenOn = true
        main.post(tick)

        if (intent.getBooleanExtra("autorun", false)) autorun()
    }

    // Transport: the overlay drives the bare player.

    override fun togglePlay() {
        val player = spike.player
        if (player.playWhenReady) player.pause() else player.play()
    }

    override fun skip(seconds: Double) {
        val player = spike.player
        player.seekTo((player.currentPosition + seconds * 1000).roundToLong().coerceAtLeast(0))
    }

    override fun seekTo(fraction: Double) {
        val duration = spike.player.duration.takeIf { it != C.TIME_UNSET } ?: return
        spike.player.seekTo((duration * fraction).roundToLong())
    }

    override fun setRate(rate: Double) = spike.player.setPlaybackSpeed(rate.toFloat())

    /**
     * The plugin's own presenter, as `ExoEngine.enterFullscreen` uses it. A player draws to one
     * surface at a time, so the inline view lets go first and takes the player back after.
     */
    override fun enterFullscreen() {
        playerView.player = null
        if (presenter.present(spike.player, onLeave = ::exitFullscreen)) {
            log("present fullscreen")
        } else {
            playerView.player = spike.player
        }
    }

    private fun exitFullscreen() {
        if (!presenter.dismiss()) return
        playerView.player = spike.player
        log("present inline")
    }

    private fun autorun() {
        buttons.forEach { it.isEnabled = false; it.alpha = 0.4f }
        scope.launch {
            spike.autorun(secondsPerVisit = 8)
            buttons.forEach { it.isEnabled = true; it.alpha = 1f }
        }
    }

    /** The Bridge screen has its own player; this one should not play on underneath it. */
    override fun onStop() {
        spike.player.pause()
        super.onStop()
    }

    override fun onDestroy() {
        main.removeCallbacks(tick)
        scope.cancel()
        presenter.dismiss()
        spike.release()
        super.onDestroy()
    }
}
