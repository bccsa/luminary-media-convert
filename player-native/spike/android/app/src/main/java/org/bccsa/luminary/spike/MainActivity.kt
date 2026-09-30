package org.bccsa.luminary.spike

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.annotation.OptIn
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.bccsa.luminary.player.engine.FullscreenPresenter

/**
 * The spike's one screen: the picture, the mode, a button per visit, and the log.
 *
 * `adb shell am start -n org.bccsa.luminary.spike/.MainActivity --ez autorun true` runs step 0
 * unattended; `adb logcat -s LmcSpike` collects it.
 */
class MainActivity : ComponentActivity() {
    private val main = Handler(Looper.getMainLooper())
    private val scope = MainScope()
    private lateinit var spike: SpikePlayer
    private var server: LocalStreamServer? = null
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var playerView: PlayerView
    private val presenter = FullscreenPresenter { this }
    private val buttons = mutableListOf<Button>()

    private fun log(line: String) {
        val stamped = "[spike] $line"
        Log.i(TAG, stamped)
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
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        logView = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 10f
            setTextColor(Color.BLACK)
            setTextIsSelectable(true)
        }
        logScroll = ScrollView(this).apply { addView(logView) }

        val payload = runCatching { Payload.bundled(this) }.onFailure { log("payload: ${it.message}") }.getOrNull()
        if (payload == null) {
            log("payload: none bundled; run `node make-payload.mjs --android <masterUrl> <keyHex>` in player-native/spike, then rebuild")
        }
        if (LocalStreamServer.bundled(assets)) {
            server = runCatching { LocalStreamServer(assets, LocalStreamServer.PORT, ::log).also { it.start() } }
                .onFailure { log("server  could not start: ${it.message}") }
                .getOrNull()
        }
        spike = SpikePlayer(this, payload, ::log)

        playerView = PlayerView(this).apply {
            player = spike.player
            setBackgroundColor(Color.BLACK)
            setFullscreenButtonState(false)
            setFullscreenButtonClickListener { enterFullscreen() }
        }
        val playerHeight = resources.displayMetrics.widthPixels * 9 / 16
        root.addView(playerView, LinearLayout.LayoutParams(MATCH_PARENT, playerHeight))

        val modes = RadioGroup(this).apply { orientation = RadioGroup.HORIZONTAL }
        SpikePlayer.Mode.entries.forEach { mode ->
            modes.addView(RadioButton(this).apply {
                id = mode.ordinal + 1
                text = mode.label
                setTextColor(Color.BLACK)
                isChecked = mode == spike.mode
                setOnClickListener { spike.mode = mode }
            })
        }
        root.addView(modes)

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        payload?.visits?.forEachIndexed { index, visit ->
            row.addView(Button(this).apply {
                text = payload.name(visit)
                isAllCaps = false
                setOnClickListener {
                    if (index == 0) spike.reset()
                    spike.play(visit, if (index == 0) 0 else spike.player.currentPosition)
                }
            }.also(buttons::add))
        }
        row.addView(Button(this).apply {
            text = "Fullscreen"
            isAllCaps = false
            setOnClickListener { enterFullscreen() }
        })
        row.addView(Button(this).apply {
            text = "Stats"
            isAllCaps = false
            setOnClickListener { spike.dumpStats("manual") }
        })
        if (payload != null) {
            row.addView(Button(this).apply {
                text = "Autorun"
                isAllCaps = false
                setOnClickListener { autorun() }
            }.also(buttons::add))
        }
        root.addView(HorizontalScrollView(this).apply { addView(row) }, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        root.addView(logScroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)
        window.decorView.keepScreenOn = true

        if (intent.getBooleanExtra("autorun", false)) autorun()
    }

    /**
     * The plugin's own presenter, as `ExoEngine.enterFullscreen` uses it. A player draws to one
     * surface at a time, so the inline view lets go first and takes the player back after.
     */
    private fun enterFullscreen() {
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
        buttons.forEach { it.isEnabled = false }
        scope.launch {
            spike.autorun(secondsPerVisit = 8)
            buttons.forEach { it.isEnabled = true }
        }
    }

    override fun onDestroy() {
        scope.cancel()
        presenter.dismiss()
        spike.release()
        server?.stop()
        super.onDestroy()
    }

    private companion object {
        const val TAG = "LmcSpike"
    }
}
