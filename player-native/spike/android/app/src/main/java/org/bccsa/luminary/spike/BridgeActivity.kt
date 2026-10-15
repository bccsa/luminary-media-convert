package org.bccsa.luminary.spike

import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The plugin's whole native side, driven by hand and laid out like the iOS spike: the frame with
 * its overlay controls, then a capsule per bridge call. Everything on screen follows the events
 * alone. Bridge v1 plays video only in native full-screen, so the inline frame is a poster, as the
 * host's would be; audio plays inline.
 */
class BridgeActivity : ComponentActivity(), Transport {
    private val main = Handler(Looper.getMainLooper())
    private var session: BridgeSession? = null
    private var payload: Payload? = null
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView
    private lateinit var status: TextView
    private lateinit var controls: TransportControls
    private lateinit var angles: CapsuleRow
    private lateinit var qualities: CapsuleRow
    private lateinit var languages: CapsuleRow
    private var exactSeek = false
    private var shownChoices = ""

    private fun log(line: String) {
        val stamped = "[bridge] $line"
        Log.i(SpikeApp.TAG, stamped)
        main.post {
            logView.append(stamped + "\n")
            logScroll.post { logScroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }

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

        val payload = Payload.bundled(this).also { payload = it }
        if (payload == null) {
            log("no payload bundled: run make-sample-stream.py (or make-payload.mjs --android) and rebuild")
            root.addView(logScroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
            setContentView(root)
            return
        }
        val session = BridgeSession(this, { this }, payload, ::log, ::refresh).also { session = it }

        // The poster the host draws, with the overlay driving the bridge.
        controls = TransportControls(this, this)
        val frame = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(TextView(context).apply {
                text = "video plays in full screen"
                textSize = 11f
                setTextColor(Ios.SECONDARY)
                setPadding(dp(12), dp(14), dp(14), dp(12))
            }, FrameLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.END))
            addView(controls, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        }
        val width = resources.displayMetrics.widthPixels - dp(24)
        root.addView(frame, LinearLayout.LayoutParams(MATCH_PARENT, width * 9 / 16))

        status = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextColor(Ios.SECONDARY)
            setPadding(dp(4), dp(8), dp(4), dp(4))
        }
        root.addView(status)

        root.addView(
            SegmentedControl(this, listOf("keyframe seek", "exact seek"), 0) { exactSeek = it == 1 },
            LinearLayout.LayoutParams(MATCH_PARENT, dp(46)),
        )

        val choices = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        angles = CapsuleRow(this)
        qualities = CapsuleRow(this)
        languages = CapsuleRow(this)
        val calls = CapsuleRow(this).apply {
            set(listOf(
                capsuleButton("Create") { session.create() },
                capsuleButton("Reattach") { session.reattach() },
                capsuleButton("New generation") { session.newGeneration() },
                capsuleButton("Resumed") { session.resumed() },
                capsuleButton("getInfo") { session.getInfo() },
                capsuleButton("Destroy") { session.destroy() },
                capsuleButton("Reset") { session.reset() },
            ))
        }
        choices.addView(sectionHeader("Angle"))
        choices.addView(angles)
        choices.addView(sectionHeader("Quality"))
        choices.addView(qualities)
        choices.addView(sectionHeader("Audio"))
        choices.addView(languages)
        choices.addView(sectionHeader("Bridge calls"))
        choices.addView(calls)
        root.addView(choices)

        root.addView(logScroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        setContentView(root)
        window.decorView.keepScreenOn = true

        session.getInfo()
        session.create()
    }

    // Transport: the overlay makes bridge calls.

    override fun togglePlay() {
        val session = session ?: return
        if (session.playing) session.pause() else session.play()
    }

    override fun skip(seconds: Double) {
        val session = session ?: return
        session.seek(session.currentTime + seconds, exactSeek)
    }

    override fun seekTo(fraction: Double) {
        val session = session ?: return
        val duration = session.duration ?: return
        session.seek(duration * fraction, exactSeek)
    }

    override fun setRate(rate: Double) {
        session?.setRate(rate)
    }

    override fun enterFullscreen() {
        session?.enterFullscreen()
    }

    /** Everything on screen, from the session's view of the events. */
    private fun refresh() {
        val session = session ?: return
        val duration = session.duration
        val state = when {
            session.playerId == null -> "no player"
            session.waiting -> "waiting"
            session.playing -> "playing"
            else -> "paused"
        }
        status.text = buildString {
            append("${session.playerId ?: "-"} · ${session.loadId ?: "-"} · gen ${session.generation} · ${session.presentation}\n")
            append("$state · %.1f / %s s · buffered %.1f s · %.2f×".format(
                session.currentTime,
                duration?.let { "%.1f".format(it) } ?: "live",
                session.bufferedEnd,
                session.rate,
            ))
        }
        controls.update(session.playing, session.currentTime, duration, session.bufferedEnd)

        // The choice rows are rebuilt only when what they offer changes.
        val shown = listOf(
            session.visitIndex, session.variants.map { it.id }, session.activeVariant,
            session.audioTracks.map { it.id }, session.activeAudio, session.playerId,
        ).toString()
        if (shown == shownChoices) return
        shownChoices = shown
        rebuildChoices(session)
    }

    private fun rebuildChoices(session: BridgeSession) {
        val payload = payload ?: return
        angles.set(payload.visits.mapIndexed { index, visit ->
            capsuleButton(payload.name(visit), prominent = index == session.visitIndex) { session.switchTo(index) }
        })
        qualities.set(
            listOf(capsuleButton("Auto", prominent = session.activeVariant == "auto") { session.setVariant("auto") }) +
                session.variants.map { variant ->
                    capsuleButton(variant.label, prominent = session.activeVariant == variant.id) { session.setVariant(variant.id) }
                },
        )
        languages.set(
            if (session.audioTracks.isEmpty()) {
                listOf(sectionHeader("none yet"))
            } else {
                session.audioTracks.map { track ->
                    capsuleButton(track.label, prominent = session.activeAudio == track.id) { session.setAudioTrack(track.id) }
                }
            },
        )
    }

    override fun onDestroy() {
        session?.release()
        super.onDestroy()
    }
}
