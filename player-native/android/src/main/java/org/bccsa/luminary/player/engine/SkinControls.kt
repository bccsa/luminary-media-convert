package org.bccsa.luminary.player.engine

import android.annotation.SuppressLint
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.CornerPathEffect
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import kotlin.math.roundToLong

/**
 * The full-screen controls, drawn to `player-web`'s skin (`styles.css`): a 30% scrim over the whole
 * picture, a 96 dp play / pause in the middle flanked by the skip circles at ±100 dp, a slim
 * progress bar along the bottom that leaves the corner to the exit button, and the audio and rate
 * menus at the top left. No spinner (the skin suppresses it), and the controls fade after three
 * seconds of playing.
 *
 * A tap shows or hides them; a double tap leaves full-screen, as the web component's own
 * double-click handler does. Everything acts on the [Player] directly, so the same controls work
 * for the plugin's engine and for a bare player.
 */
@OptIn(UnstableApi::class)
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
internal class SkinControls(
    context: Context,
    private val player: Player,
    private val options: SkinOptions,
    private val onLeave: () -> Unit,
) : FrameLayout(context), Player.Listener {
    private val main = Handler(Looper.getMainLooper())
    private val panel = FrameLayout(context)
    private val menuLayer = FrameLayout(context)
    private val play = Glyph(context, Glyph.Kind.PLAY)
    private val back: Glyph?
    private val forward: Glyph?
    private val audioButton = Glyph(context, Glyph.Kind.AUDIO)
    private val rateButton = Glyph(context, Glyph.Kind.RATE)
    private val exitButton = Glyph(context, Glyph.Kind.EXIT)
    private val live = TextView(context)
    private val scrubber = Scrubber(context, ::seekToFraction)
    private var menuOpen = false
    private var shown = true
    private var attached = false

    private val hide = Runnable { if (canHide()) setShown(false) }
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            main.postDelayed(this, TICK_MS)
        }
    }
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent) = true

        override fun onSingleTapConfirmed(e: MotionEvent): Boolean {
            if (menuOpen) closeMenu() else setShown(!shown)
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            onLeave()
            return true
        }
    })

    init {
        setBackgroundColor(Color.TRANSPARENT)
        panel.setBackgroundColor(SCRIM)
        addView(panel, LayoutParams(MATCH_PARENT, MATCH_PARENT))

        // Top left: the audio menu, then the rate menu, floated left as the skin's control bar does.
        val top = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
        top.addView(audioButton.tap { openAudioMenu() }, LinearLayout.LayoutParams(dp(44), dp(44)))
        top.addView(rateButton.tap { openRateMenu() }, LinearLayout.LayoutParams(dp(44), dp(44)))
        panel.addView(top, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START))

        // Middle: play / pause, with the skip circles at ±100 dp from the centre, a little above it.
        panel.addView(play.tap { playOrPause() }, LayoutParams(dp(96), dp(96), Gravity.CENTER))
        back = options.back?.let { seconds ->
            Glyph(context, Glyph.Kind.SKIP_BACK, seconds).tap { skip(-seconds) }.also {
                it.contentDescription = "Back $seconds seconds"
                panel.addView(it, skipParams(-1))
            }
        }
        forward = options.forward?.let { seconds ->
            Glyph(context, Glyph.Kind.SKIP_FORWARD, seconds).tap { skip(seconds) }.also {
                it.contentDescription = "Forward $seconds seconds"
                panel.addView(it, skipParams(1))
            }
        }

        // Bottom: the bar runs to 40 dp short of the corner, which belongs to the exit button.
        panel.addView(
            scrubber,
            LayoutParams(MATCH_PARENT, dp(44), Gravity.BOTTOM).apply {
                leftMargin = dp(8)
                rightMargin = dp(40)
            },
        )
        live.apply {
            text = "LIVE"
            setTextColor(Color.WHITE)
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER_VERTICAL
            visibility = GONE
        }
        panel.addView(live, LayoutParams(WRAP_CONTENT, dp(44), Gravity.BOTTOM or Gravity.START).apply { leftMargin = dp(16) })
        panel.addView(exitButton.tap { onLeave() }, LayoutParams(dp(44), dp(44), Gravity.BOTTOM or Gravity.END))

        play.contentDescription = "Play"
        audioButton.contentDescription = "Audio language"
        rateButton.contentDescription = "Playback rate"
        exitButton.contentDescription = "Exit full screen"
        addView(menuLayer, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        refresh()
    }

    // Lifecycle.

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        attached = true
        player.addListener(this)
        refresh()
        main.post(tick)
        scheduleHide()
    }

    override fun onDetachedFromWindow() {
        attached = false
        player.removeListener(this)
        main.removeCallbacks(tick)
        main.removeCallbacks(hide)
        super.onDetachedFromWindow()
    }

    // Touch: only what the controls did not take.

    override fun onTouchEvent(event: MotionEvent): Boolean = gestures.onTouchEvent(event)

    // The player, followed.

    override fun onIsPlayingChanged(isPlaying: Boolean) = playingChanged()

    override fun onPlaybackStateChanged(playbackState: Int) = playingChanged()

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = playingChanged()

    override fun onTracksChanged(tracks: Tracks) = refresh()

    override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) = refresh()

    private fun playingChanged() {
        refresh()
        if (Util.shouldShowPlayButton(player)) setShown(true) else scheduleHide()
    }

    /** Everything drawn, from the player's state. */
    private fun refresh() {
        val showPlay = Util.shouldShowPlayButton(player)
        play.kind = if (showPlay) Glyph.Kind.PLAY else Glyph.Kind.PAUSE
        play.contentDescription = if (showPlay) "Play" else "Pause"

        val isLive = player.isCurrentMediaItemLive
        // Live has nothing to skip to and no rate to change.
        listOfNotNull(back, forward, rateButton).forEach { it.visibility = if (isLive) GONE else VISIBLE }
        live.visibility = if (isLive) VISIBLE else GONE
        scrubber.visibility = if (isLive) GONE else VISIBLE
        audioButton.visibility = if (audioTracks().size > 1) VISIBLE else GONE

        val speed = player.playbackParameters.speed
        rateButton.label = "${formatRate(speed)}x"

        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
        if (duration != null) scrubber.show(player.currentPosition.toDouble() / duration, player.bufferedPosition.toDouble() / duration)
    }

    // Actions.

    private fun playOrPause() {
        if (Util.shouldShowPlayButton(player)) Util.handlePlayButtonAction(player) else Util.handlePauseButtonAction(player)
        scheduleHide()
    }

    private fun skip(seconds: Int) {
        val duration = player.duration.takeIf { it != C.TIME_UNSET } ?: Long.MAX_VALUE
        player.seekTo((player.currentPosition + seconds * 1000L).coerceIn(0L, duration))
        scheduleHide()
    }

    private fun seekToFraction(fraction: Double) {
        val duration = player.duration.takeIf { it != C.TIME_UNSET } ?: return
        player.seekTo((duration * fraction).roundToLong())
        scheduleHide()
    }

    // Auto-hide: three seconds, only while playing and with nothing open or being dragged.

    private fun canHide() = !menuOpen && !scrubber.dragging && !Util.shouldShowPlayButton(player)

    private fun scheduleHide() {
        main.removeCallbacks(hide)
        if (attached && canHide()) main.postDelayed(hide, AUTO_HIDE_MS)
    }

    private fun setShown(show: Boolean) {
        shown = show
        main.removeCallbacks(hide)
        panel.animate().cancel()
        if (show) {
            panel.visibility = VISIBLE
            panel.animate().alpha(1f).setDuration(FADE_IN_MS).start()
            scheduleHide()
        } else {
            // Quick to arrive, unhurried to leave: the skin's asymmetry.
            panel.animate().alpha(0f).setDuration(FADE_OUT_MS).withEndAction { if (!shown) panel.visibility = GONE }.start()
        }
    }

    /** Whether the controls are on screen; the controls are up while paused. */
    val controlsShown: Boolean get() = shown

    // Menus.

    private fun audioTracks(): List<Pair<String, Boolean>> = buildList {
        for (group in player.currentTracks.groups) {
            if (group.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until group.length) {
                if (!group.isTrackSupported(i)) continue
                val format = group.getTrackFormat(i)
                add((format.label ?: format.language ?: "Track ${size + 1}") to group.isTrackSelected(i))
            }
        }
    }

    private fun openAudioMenu() {
        val choices = mutableListOf<Pair<String, Boolean>>()
        val overrides = mutableListOf<TrackSelectionOverride>()
        for (group in player.currentTracks.groups) {
            if (group.type != C.TRACK_TYPE_AUDIO) continue
            for (i in 0 until group.length) {
                if (!group.isTrackSupported(i)) continue
                val format = group.getTrackFormat(i)
                choices += (format.label ?: format.language ?: "Track ${choices.size + 1}") to group.isTrackSelected(i)
                overrides += TrackSelectionOverride(group.mediaTrackGroup, i)
            }
        }
        openMenu(audioButton, choices) { index ->
            player.trackSelectionParameters = player.trackSelectionParameters.buildUpon().setOverrideForType(overrides[index]).build()
        }
    }

    private fun openRateMenu() {
        val current = player.playbackParameters.speed
        openMenu(rateButton, RATES.map { "${formatRate(it)}x" to (kotlin.math.abs(it - current) < 0.01f) }) { index ->
            player.setPlaybackSpeed(RATES[index])
        }
    }

    /** The skin's menu: a light card beside its button, the chosen item bold on a grey. */
    private fun openMenu(anchor: View, choices: List<Pair<String, Boolean>>, pick: (Int) -> Unit) {
        closeMenu()
        if (choices.isEmpty()) return
        val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(if (night) 0xFF52525B.toInt() else 0xFFFAFAFA.toInt())
                cornerRadius = dp(6).toFloat()
            }
            elevation = dp(8).toFloat()
        }
        choices.forEachIndexed { index, (label, selected) ->
            card.addView(
                TextView(context).apply {
                    text = label
                    textSize = 14f
                    setPadding(dp(12), dp(12), dp(12), dp(12))
                    setTextColor(if (night) 0xFFF1F5F9.toInt() else 0xFF18181B.toInt())
                    if (selected) {
                        typeface = Typeface.DEFAULT_BOLD
                        setBackgroundColor(if (night) 0xFF71717A.toInt() else 0xFFD4D4D8.toInt())
                    }
                    contentDescription = label
                    setOnClickListener {
                        pick(index)
                        closeMenu()
                    }
                },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
            )
        }
        val where = IntArray(2).also { anchor.getLocationInWindow(it) }
        val here = IntArray(2).also { getLocationInWindow(it) }
        // Beside the button, a little below the top of the bar: `left: 2.75rem; top: 1rem`.
        menuLayer.addView(
            card,
            LayoutParams(dp(MENU_WIDTH), WRAP_CONTENT).apply {
                leftMargin = where[0] - here[0] + dp(44)
                topMargin = where[1] - here[1] + dp(16)
            },
        )
        menuOpen = true
        main.removeCallbacks(hide)
    }

    private fun closeMenu() {
        menuLayer.removeAllViews()
        menuOpen = false
        scheduleHide()
    }

    /** True while a menu is open; it swallows the tap that would have toggled the controls. */
    val hasMenuOpen: Boolean get() = menuOpen

    // Layout helpers.

    /**
     * Centred ±72 dp from the middle (the skin's `50% ∓ 100px` edges), 14 dp above it. A centred
     * child in a FrameLayout moves by the whole difference of its margins, so each margin is the
     * offset itself, not twice it.
     */
    private fun skipParams(side: Int) = LayoutParams(dp(56), dp(56), Gravity.CENTER).apply {
        leftMargin = if (side > 0) dp(72) else 0
        rightMargin = if (side < 0) dp(72) else 0
        topMargin = 0
        bottomMargin = dp(14)
    }

    private fun Glyph.tap(action: () -> Unit) = apply {
        isClickable = true
        setOnClickListener { action() }
    }

    private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun formatRate(rate: Float) = if (rate == rate.toInt().toFloat()) rate.toInt().toString() else "%.2f".format(rate).trimEnd('0').trimEnd('.')

    companion object {
        /** The skin's `playbackRates`. */
        val RATES = listOf(0.5f, 0.7f, 1f, 1.5f)
        const val AUTO_HIDE_MS = 3000L
        const val FADE_IN_MS = 100L
        const val FADE_OUT_MS = 500L
        private const val TICK_MS = 250L
        private const val MENU_WIDTH = 132
        private const val SCRIM = 0x4D000000
    }
}

/** The slim progress bar: played white over buffered over the track, video.js's colours. */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
private class Scrubber(context: Context, private val onSeek: (Double) -> Unit) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var played = 0.0
    private var buffered = 0.0
    var dragging = false
        private set
    private var dragAt = 0.0

    fun show(played: Double, buffered: Double) {
        if (dragging) return
        this.played = played.coerceIn(0.0, 1.0)
        this.buffered = buffered.coerceIn(0.0, 1.0)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val thickness = resources.displayMetrics.density * if (dragging) 8f else 5f
        val top = (height - thickness) / 2
        val radius = thickness / 2
        fun bar(fraction: Double, color: Int) {
            paint.color = color
            canvas.drawRoundRect(RectF(0f, top, (width * fraction).toFloat(), top + thickness), radius, radius, paint)
        }
        bar(1.0, 0x8073859F.toInt())
        bar(buffered, 0xBF73859F.toInt())
        val at = if (dragging) dragAt else played
        bar(at, Color.WHITE)
        paint.color = Color.WHITE
        canvas.drawCircle((width * at).toFloat(), height / 2f, thickness * 1.1f, paint)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        val fraction = (event.x / width).toDouble().coerceIn(0.0, 1.0)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE -> {
                parent.requestDisallowInterceptTouchEvent(true)
                dragging = true
                dragAt = fraction
            }
            MotionEvent.ACTION_UP -> {
                dragging = false
                played = fraction
                onSeek(fraction)
            }
            MotionEvent.ACTION_CANCEL -> dragging = false
        }
        invalidate()
        return true
    }
}

/** The skin's icons, drawn rather than bundled. */
@SuppressLint("ViewConstructor")
private class Glyph(context: Context, kind: Kind, private val seconds: Int = 0) : View(context) {
    enum class Kind { PLAY, PAUSE, SKIP_BACK, SKIP_FORWARD, AUDIO, RATE, EXIT }

    var kind = kind
        set(value) {
            field = value
            invalidate()
        }
    var label = ""
        set(value) {
            field = value
            invalidate()
        }

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        typeface = Typeface.DEFAULT_BOLD
        textAlign = Paint.Align.CENTER
    }

    override fun onDraw(canvas: Canvas) {
        val s = minOf(width, height).toFloat()
        val cx = width / 2f
        val cy = height / 2f
        fun x(f: Float) = cx + (f - 0.5f) * s
        fun y(f: Float) = cy + (f - 0.5f) * s
        // Legible over any picture, as the skin's drop shadow makes it.
        fill.setShadowLayer(s * 0.05f, 0f, s * 0.02f, 0x80000000.toInt())
        stroke.setShadowLayer(s * 0.05f, 0f, s * 0.02f, 0x80000000.toInt())
        when (kind) {
            Kind.PLAY -> {
                fill.pathEffect = CornerPathEffect(s * 0.05f)
                canvas.drawPath(Path().apply {
                    moveTo(x(0.36f), y(0.26f))
                    lineTo(x(0.36f), y(0.74f))
                    lineTo(x(0.76f), y(0.5f))
                    close()
                }, fill)
                fill.pathEffect = null
            }
            Kind.PAUSE -> {
                val r = s * 0.03f
                canvas.drawRoundRect(RectF(x(0.33f), y(0.27f), x(0.46f), y(0.73f)), r, r, fill)
                canvas.drawRoundRect(RectF(x(0.54f), y(0.27f), x(0.67f), y(0.73f)), r, r, fill)
            }
            Kind.SKIP_BACK, Kind.SKIP_FORWARD -> {
                val back = kind == Kind.SKIP_BACK
                val r = s * 0.30f
                stroke.strokeWidth = s * 0.06f
                val oval = RectF(cx - r, cy - r, cx + r, cy + r)
                // A ring open at the top, with the arrow pointing into the gap.
                if (back) canvas.drawArc(oval, -80f, 300f, false, stroke) else canvas.drawArc(oval, -100f, -300f, false, stroke)
                val tip = if (back) cx - s * 0.12f else cx + s * 0.12f
                val base = if (back) cx + s * 0.02f else cx - s * 0.02f
                canvas.drawPath(Path().apply {
                    moveTo(tip, cy - r)
                    lineTo(base, cy - r - s * 0.09f)
                    lineTo(base, cy - r + s * 0.09f)
                    close()
                }, fill)
                text.textSize = s * 0.27f
                canvas.drawText(seconds.toString(), cx, cy - (text.descent() + text.ascent()) / 2, text)
            }
            Kind.RATE -> {
                text.textSize = s * 0.32f
                canvas.drawText(label, cx, cy - (text.descent() + text.ascent()) / 2, text)
            }
            Kind.AUDIO -> {
                // A speaker with two waves.
                fill.pathEffect = CornerPathEffect(s * 0.03f)
                canvas.drawPath(Path().apply {
                    moveTo(x(0.26f), y(0.42f))
                    lineTo(x(0.38f), y(0.42f))
                    lineTo(x(0.52f), y(0.28f))
                    lineTo(x(0.52f), y(0.72f))
                    lineTo(x(0.38f), y(0.58f))
                    lineTo(x(0.26f), y(0.58f))
                    close()
                }, fill)
                fill.pathEffect = null
                stroke.strokeWidth = s * 0.045f
                canvas.drawArc(RectF(x(0.40f), y(0.36f), x(0.66f), y(0.64f)), -45f, 90f, false, stroke)
                canvas.drawArc(RectF(x(0.42f), y(0.24f), x(0.78f), y(0.76f)), -45f, 90f, false, stroke)
            }
            Kind.EXIT -> {
                // Four corners pointing inward: video.js's fullscreen-exit.
                stroke.strokeWidth = s * 0.06f
                fun corner(px: Float, py: Float, dx: Float, dy: Float) {
                    canvas.drawLine(x(px), y(py), x(px + dx), y(py), stroke)
                    canvas.drawLine(x(px), y(py), x(px), y(py + dy), stroke)
                }
                corner(0.40f, 0.40f, -0.14f, -0.14f)
                corner(0.60f, 0.40f, 0.14f, -0.14f)
                corner(0.40f, 0.60f, -0.14f, 0.14f)
                corner(0.60f, 0.60f, 0.14f, 0.14f)
            }
        }
    }
}
