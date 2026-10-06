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
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import kotlin.math.roundToLong

/**
 * The full-screen controls, drawn to `player-web`'s skin (`styles.css`) with video.js's own glyphs: a
 * 30% scrim over the whole picture, a 96 dp play / pause in the middle flanked by the skip circles
 * at ±72 dp, a slim progress bar along the bottom with the time before it and the exit button
 * after it, and the audio, rate and mute buttons at the top left. A spinner takes the place of
 * play / pause while waiting for data the viewer asked for, and the controls fade after three
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
    private val play = Glyph(context, VideoJsIcons.play, PLAY_ICON_DP)
    private val spinner = Spinner(context)
    private val back: Glyph?
    private val forward: Glyph?
    private val audioButton = Glyph(context, VideoJsIcons.audio, ICON_DP)
    private val rateButton = Glyph(context, null, ICON_DP)
    private val muteButton = Glyph(context, VideoJsIcons.volumeHigh, ICON_DP)
    private val exitButton = Glyph(context, VideoJsIcons.fullscreenExit, ICON_DP)
    private val time = TextView(context)
    private var volumeBeforeMute = 1f
    private val scrubber = Scrubber(context, ::seekToFraction) { if (menuOpen) closeMenu() }
    private var menuOpen = false
    private var shown = true
    private var attached = false
    private var safe = Insets.NONE

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
        top.addView(muteButton.tap { toggleMute() }, LinearLayout.LayoutParams(dp(44), dp(44)))
        panel.addView(top, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.TOP or Gravity.START))

        // Middle: play / pause, with the skip circles at ±100 dp from the centre, a little above it.
        panel.addView(play.tap { playOrPause() }, LayoutParams(dp(96), dp(96), Gravity.CENTER))
        panel.addView(spinner, LayoutParams(dp(96), dp(96), Gravity.CENTER))
        back = options.back?.let { seconds ->
            Glyph(context, skipGlyph(seconds, back = true), SKIP_ICON_DP).tap { skip(-seconds) }.also {
                it.contentDescription = "Back $seconds seconds"
                panel.addView(it, skipParams(-1))
            }
        }
        forward = options.forward?.let { seconds ->
            Glyph(context, skipGlyph(seconds, back = false), SKIP_ICON_DP).tap { skip(seconds) }.also {
                it.contentDescription = "Forward $seconds seconds"
                panel.addView(it, skipParams(1))
            }
        }

        // Bottom: the time, the bar, then the exit button. Live has `LIVE` and no bar.
        time.apply {
            setTextColor(Color.WHITE)
            textSize = 14f
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(10), 0)
            setShadowLayer(dp(2).toFloat(), 0f, dp(1).toFloat(), 0x80000000.toInt())
        }
        val bottom = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(time, LinearLayout.LayoutParams(WRAP_CONTENT, dp(44)))
            addView(scrubber, LinearLayout.LayoutParams(0, dp(44), 1f).apply { rightMargin = dp(8) })
            addView(exitButton.tap { onLeave() }, LinearLayout.LayoutParams(dp(44), dp(44)))
        }
        panel.addView(bottom, LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))

        play.contentDescription = "Play"
        audioButton.contentDescription = "Audio language"
        rateButton.contentDescription = "Playback rate"
        muteButton.contentDescription = "Mute"
        spinner.contentDescription = "Loading"
        exitButton.contentDescription = "Exit full screen"
        addView(menuLayer, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // The scrim stays edge to edge; the controls on it stay clear of the system's.
        ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
            safe = safeInsets(insets)
            padClearOfSystem()
            insets
        }
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> padClearOfSystem() }
        refresh()
    }

    // Lifecycle.

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        ViewCompat.requestApplyInsets(this)
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

    override fun onVolumeChanged(volume: Float) = refresh()

    private fun playingChanged() {
        refresh()
        if (Util.shouldShowPlayButton(player)) setShown(true) else scheduleHide()
    }

    /** Everything drawn, from the player's state. */
    private fun refresh() {
        val showPlay = Util.shouldShowPlayButton(player)
        play.glyph = if (showPlay) VideoJsIcons.play else VideoJsIcons.pause
        play.contentDescription = if (showPlay) "Play" else "Pause"

        // Waiting for data the viewer asked to see: the spinner stands in for play / pause.
        val waiting = player.playWhenReady && player.playbackState == Player.STATE_BUFFERING
        spinner.visibility = if (waiting) VISIBLE else GONE
        play.visibility = if (waiting) INVISIBLE else VISIBLE

        val isLive = player.isCurrentMediaItemLive
        // Live has nothing to skip to and no rate to change.
        listOfNotNull(back, forward, rateButton).forEach { it.visibility = if (isLive) GONE else VISIBLE }
        scrubber.visibility = if (isLive) GONE else VISIBLE
        audioButton.visibility = if (audioTracks().size > 1) VISIBLE else GONE

        val speed = player.playbackParameters.speed
        rateButton.label = "${formatRate(speed)}x"
        ViewCompat.setStateDescription(rateButton, rateButton.label)

        val muted = player.volume == 0f
        muteButton.glyph = if (muted) VideoJsIcons.volumeMute else VideoJsIcons.volumeHigh
        muteButton.contentDescription = if (muted) "Unmute" else "Mute"

        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
        val label = timeText(isLive, player.currentPosition / 1000.0, (duration ?: 0L) / 1000.0)
        if (time.text.toString() != label) time.text = label

        if (duration != null) scrubber.show(player.currentPosition.toDouble() / duration, player.bufferedPosition.toDouble() / duration)
    }

    // Actions.

    private fun playOrPause() {
        if (Util.shouldShowPlayButton(player)) Util.handlePlayButtonAction(player) else Util.handlePauseButtonAction(player)
        scheduleHide()
    }

    private fun toggleMute() {
        if (player.volume == 0f) {
            player.volume = volumeBeforeMute
        } else {
            volumeBeforeMute = player.volume
            player.volume = 0f
        }
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

    /**
     * Where the system draws or takes touches: the bars where they are when shown (full-screen
     * hides them, but a swipe or three-button navigation brings them back over the picture), the
     * camera cutout, and the edges whose swipes the system always claims.
     */
    private fun safeInsets(insets: WindowInsetsCompat): Insets = Insets.max(
        insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars()),
        Insets.max(
            insets.getInsets(WindowInsetsCompat.Type.displayCutout()),
            insets.getInsets(WindowInsetsCompat.Type.mandatorySystemGestures()),
        ),
    )

    /**
     * The insets are the window's, and this view may already sit inside them (the window can keep
     * it below a camera cutout), so only the part it overlaps is padded.
     */
    private fun padClearOfSystem() {
        val window = rootView
        val at = IntArray(2).also(::getLocationInWindow)
        val left = (safe.left - at[0]).coerceAtLeast(0)
        val top = (safe.top - at[1]).coerceAtLeast(0)
        val right = (safe.right - (window.width - at[0] - width)).coerceAtLeast(0)
        val bottom = (safe.bottom - (window.height - at[1] - height)).coerceAtLeast(0)
        // Padding only when it changes: setting it lays the view out again.
        if (panel.paddingLeft != left || panel.paddingTop != top || panel.paddingRight != right || panel.paddingBottom != bottom) {
            panel.setPadding(left, top, right, bottom)
        }
    }

    /** Tapping a control closes an open menu, as video.js's menus close when they lose focus. */
    private fun Glyph.tap(action: () -> Unit) = apply {
        isClickable = true
        setOnClickListener {
            if (menuOpen) closeMenu()
            action()
        }
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

        // video.js draws an icon at 1.8 em: the controls' 25, the play button's 54, the skips' 36.
        const val ICON_DP = 25
        const val PLAY_ICON_DP = 54
        const val SKIP_ICON_DP = 36

        /** video.js's `replay-N` / `forward-N` glyph for the seconds the options snapped to. */
        fun skipGlyph(seconds: Int, back: Boolean): VideoJsGlyph = when (seconds) {
            5 -> if (back) VideoJsIcons.replay5 else VideoJsIcons.forward5
            10 -> if (back) VideoJsIcons.replay10 else VideoJsIcons.forward10
            else -> if (back) VideoJsIcons.replay30 else VideoJsIcons.forward30
        }
    }
}

/** The slim progress bar: played white over buffered over the track, video.js's colours. */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
private class Scrubber(
    context: Context,
    private val onSeek: (Double) -> Unit,
    private val onTouch: () -> Unit,
) : View(context) {
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
                if (event.actionMasked == MotionEvent.ACTION_DOWN) onTouch()
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

/** One of the skin's controls: a video.js glyph, or the rate's text, centred in the view. */
@SuppressLint("ViewConstructor")
private class Glyph(context: Context, glyph: VideoJsGlyph?, private val iconDp: Int) : View(context) {
    var glyph = glyph
        set(value) {
            if (field === value) return
            field = value
            cached = null
            invalidate()
        }
    var label = ""
        set(value) {
            field = value
            invalidate()
        }

    private var cached: Path? = null
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        textAlign = Paint.Align.CENTER
    }

    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val size = iconDp * density
        // Legible over any picture, as the skin's drop shadow makes it.
        fill.setShadowLayer(size * 0.06f, 0f, size * 0.03f, 0x80000000.toInt())
        val icon = glyph
        if (icon == null) {
            // video.js's rate label: 1.5 em of 0.875 rem.
            text.textSize = RATE_TEXT_DP * density
            text.setShadowLayer(size * 0.06f, 0f, size * 0.03f, 0x80000000.toInt())
            canvas.drawText(label, width / 2f, height / 2f - (text.descent() + text.ascent()) / 2, text)
            return
        }
        val path = cached ?: icon.path(size).also { cached = it }
        canvas.save()
        canvas.translate((width - size) / 2, (height - size) / 2)
        canvas.drawPath(path, fill)
        canvas.restore()
    }

    private companion object {
        const val RATE_TEXT_DP = 21
    }
}

/** A white ring, three quarters round, turning: the buffering spinner, at the play button's size. */
@SuppressLint("ViewConstructor")
private class Spinner(context: Context) : View(context) {
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
    }
    private var turning: android.animation.ObjectAnimator? = null

    init {
        isClickable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    }

    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val side = minOf(width, height) * 0.6f
        ring.strokeWidth = 4 * density
        val inset = 2 * density
        val left = (width - side) / 2 + inset
        val top = (height - side) / 2 + inset
        canvas.drawArc(RectF(left, top, left + side - 2 * inset, top + side - 2 * inset), 0f, 270f, false, ring)
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (changedView === this) updateTurning()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        updateTurning()
    }

    /** Only while shown and attached: an animator left running would keep the view alive. */
    override fun onDetachedFromWindow() {
        turning?.cancel()
        turning = null
        super.onDetachedFromWindow()
    }

    private fun updateTurning() {
        if (isShown && isAttachedToWindow) {
            if (turning == null) {
                turning = android.animation.ObjectAnimator.ofFloat(this, ROTATION, 0f, 360f).apply {
                    duration = 1000
                    repeatCount = android.animation.ValueAnimator.INFINITE
                    interpolator = android.view.animation.LinearInterpolator()
                    start()
                }
            }
        } else {
            turning?.cancel()
            turning = null
        }
    }
}
