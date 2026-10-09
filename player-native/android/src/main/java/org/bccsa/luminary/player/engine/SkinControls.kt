package org.bccsa.luminary.player.engine

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
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
import androidx.core.graphics.PathParser
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import org.bccsa.luminary.player.Roster
import org.bccsa.luminary.player.Thumbnails

/**
 * The full-screen controls, drawn to `player-web`'s Video.js 10 skin (`styles.css`): the skip circles
 * either side of a round play / pause in the middle; under them the timeline, with the time played
 * before it and the time left after it; and under that one row of buttons, the settings at the left
 * and picture in picture and leaving full-screen at the right. A dark fade rises from the bottom edge
 * so white controls read over a bright picture.
 *
 * Holding the timeline opens a roster of frames in the timeline's place and lifts the timeline onto
 * it, thin, so the frames around the playhead can be seen as it is dragged ([Thumbnails] has them).
 *
 * A tap shows or hides the controls and a double tap leaves full-screen, as the web component's own
 * double-click does. A spinner takes the place of play / pause while waiting for data the viewer
 * asked for, and the controls fade after three seconds of playing. Everything acts on the [Player]
 * directly, so the same controls work for the plugin's engine and for a bare player.
 */
@OptIn(UnstableApi::class)
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
internal class SkinControls(
    context: Context,
    private val player: Player,
    private val options: SkinOptions,
    private val texts: FullscreenTexts = FullscreenTexts(),
    /** Starts picture in picture; no button when null. */
    private val onPictureInPicture: (() -> Unit)? = null,
    /** The scrub frames; no roster when null or empty. */
    private val thumbnails: Thumbnails? = null,
    private val onLeave: () -> Unit,
) : FrameLayout(context), Player.Listener {
    private val main = Handler(Looper.getMainLooper())
    private val panel = FrameLayout(context)
    private val menuLayer = FrameLayout(context)

    private val play = Icon(context, V10Icons.play, circle = true)
    private val spinner = Spinner(context)
    private val back: Icon?
    private val forward: Icon?
    private val audioButton = Icon(context, V10Icons.speech)
    private val pipButton = Icon(context, V10Icons.pip)
    private val subtitlesButton = Icon(context, V10Icons.captions)
    private val rateButton = Icon(context, V10Icons.speed)
    private val muteButton = Icon(context, V10Icons.volumeHigh)
    private val exitButton = Icon(context, V10Icons.fullscreenExit)

    private val elapsed = timeView(Gravity.START or Gravity.CENTER_VERTICAL)
    private val remaining = timeView(Gravity.END or Gravity.CENTER_VERTICAL)
    private val timeline = Timeline(context, ::scrubbed, ::scrubEnded) { if (menuOpen) closeMenu() }
    private val timelineRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    private val actionsRow = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    private val column = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val centre = LinearLayout(context).apply { orientation = LinearLayout.HORIZONTAL }
    private val roster = RosterView(context)
    private val label = TextView(context)
    private val fade = FadeDrawable()

    private var volumeBeforeMute = 1f
    private var inPictureInPicture = false
    private var menuOpen = false
    private var shown = true
    private var attached = false
    private var safe = Insets.NONE
    private var rosterOpen = false
    private var scale = 1f
    private var widthDp = 0f

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
            if (inPictureInPicture) return true
            if (menuOpen) closeMenu() else setShown(!shown)
            return true
        }

        override fun onDoubleTap(e: MotionEvent): Boolean {
            if (inPictureInPicture) return true
            onLeave()
            return true
        }
    })

    init {
        setBackgroundColor(Color.TRANSPARENT)
        panel.setBackgroundColor(Color.TRANSPARENT)
        addView(panel, LayoutParams(MATCH_PARENT, MATCH_PARENT))

        // Middle: the skips either side of play / pause; a spinner stands in for play while waiting.
        back = options.back?.let { seconds ->
            Icon(context, null, circle = true).apply { skip = Skip(seconds, forward = false) }.tap { skip(-seconds) }.also {
                it.contentDescription = texts.skipBack(seconds)
            }
        }
        forward = options.forward?.let { seconds ->
            Icon(context, null, circle = true).apply { skip = Skip(seconds, forward = true) }.tap { skip(seconds) }.also {
                it.contentDescription = texts.skipForward(seconds)
            }
        }
        back?.let { centre.addView(it) }
        centre.addView(
            FrameLayout(context).apply {
                addView(play.tap { playOrPause() }, LayoutParams(MATCH_PARENT, MATCH_PARENT))
                addView(spinner, LayoutParams(MATCH_PARENT, MATCH_PARENT))
            },
        )
        forward?.let { centre.addView(it) }
        centre.gravity = Gravity.CENTER
        panel.addView(centre, LayoutParams(MATCH_PARENT, MATCH_PARENT, Gravity.CENTER))

        // Bottom: the timeline, then the buttons.
        timelineRow.addView(elapsed)
        timelineRow.addView(timeline)
        timelineRow.addView(remaining)
        column.addView(timelineRow)
        actionsRow.addView(muteButton.tap { toggleMute() })
        actionsRow.addView(audioButton.tap { openAudioMenu() })
        actionsRow.addView(rateButton.tap { openRateMenu() })
        actionsRow.addView(subtitlesButton.tap { openSubtitlesMenu() })
        actionsRow.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        actionsRow.addView(pipButton.tap { onPictureInPicture?.invoke() })
        actionsRow.addView(exitButton.tap { onLeave() })
        column.addView(actionsRow)
        column.background = fade
        // The timeline lifts out of the column onto the roster; a view moved outside its parent is clipped.
        column.clipChildren = false
        column.clipToPadding = false

        panel.addView(roster, LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
        panel.addView(column, LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
        label.apply {
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            gravity = Gravity.CENTER
            elevation = dpf(6f)
            visibility = GONE
        }
        panel.addView(label, LayoutParams(WRAP_CONTENT, WRAP_CONTENT, Gravity.BOTTOM or Gravity.START))
        roster.visibility = GONE

        play.contentDescription = texts.play
        audioButton.contentDescription = texts.audioMenu
        rateButton.contentDescription = texts.playbackRate
        muteButton.contentDescription = texts.mute
        pipButton.contentDescription = texts.pictureInPicture
        subtitlesButton.contentDescription = texts.subtitlesMenu
        pipButton.visibility = if (onPictureInPicture != null) VISIBLE else GONE
        spinner.contentDescription = texts.loading
        exitButton.contentDescription = texts.exitFullscreen
        timeline.contentDescription = texts.seek
        addView(menuLayer, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // The controls stay clear of the system's own edges.
        ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
            safe = safeInsets(insets)
            padClearOfSystem()
            insets
        }
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> padClearOfSystem() }
        thumbnails?.onChange = {
            roster.invalidate()
            if (rosterOpen) updateRoster(timeline.dragAt)
        }
        applyScale()
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
        if (thumbnails?.onChange != null) thumbnails.onChange = null
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val dp = w / resources.displayMetrics.density
        if (dp != widthDp) {
            widthDp = dp
            applyScale()
        }
    }

    // Touch: only what the controls did not take.

    override fun onTouchEvent(event: MotionEvent): Boolean = gestures.onTouchEvent(event)

    // The player, followed.

    override fun onIsPlayingChanged(isPlaying: Boolean) = playingChanged()

    override fun onPlaybackStateChanged(playbackState: Int) = playingChanged()

    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = playingChanged()

    override fun onTracksChanged(tracks: Tracks) = refresh()

    /**
     * While the picture is in its own small window the controls would cover it: nothing but the
     * picture shows, and a tap does not bring them back until full-screen returns.
     */
    fun setPictureInPicture(active: Boolean) {
        inPictureInPicture = active
        panel.visibility = if (active) GONE else VISIBLE
        menuLayer.visibility = if (active) GONE else VISIBLE
        if (active) closeMenu() else setShown(true)
    }

    override fun onPlaybackParametersChanged(playbackParameters: androidx.media3.common.PlaybackParameters) = refresh()

    override fun onVolumeChanged(volume: Float) = refresh()

    private fun playingChanged() {
        refresh()
        if (Util.shouldShowPlayButton(player)) setShown(true) else scheduleHide()
    }

    /** Everything drawn, from the player's state. */
    private fun refresh() {
        val showPlay = Util.shouldShowPlayButton(player)
        play.layers = if (showPlay) V10Icons.play else V10Icons.pause
        play.contentDescription = if (showPlay) texts.play else texts.pause

        // Waiting for data the viewer asked to see: the spinner stands in for play / pause.
        val waiting = player.playWhenReady && player.playbackState == Player.STATE_BUFFERING
        spinner.visibility = if (waiting) VISIBLE else GONE
        play.visibility = if (waiting) INVISIBLE else VISIBLE

        val isLive = player.isCurrentMediaItemLive
        // Live has nothing to skip to and no rate to change.
        listOfNotNull(back, forward, rateButton).forEach { it.visibility = if (isLive) GONE else VISIBLE }
        // Invisible, not gone: the bar is what keeps the buttons where they are.
        timeline.visibility = if (isLive) INVISIBLE else VISIBLE
        audioButton.visibility = if (audioTracks().size > 1) VISIBLE else GONE
        // The skin shows its captions button only when the source has subtitles.
        subtitlesButton.visibility = if (subtitleChoicesOf(player.currentTracks).isNotEmpty()) VISIBLE else GONE

        val speed = player.playbackParameters.speed
        rateButton.label = "${formatRate(speed)}x"
        ViewCompat.setStateDescription(rateButton, rateButton.label)

        val muted = player.volume == 0f
        muteButton.layers = if (muted) V10Icons.volumeOff else V10Icons.volumeHigh
        muteButton.contentDescription = if (muted) texts.unmute else texts.mute

        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }
        val position = player.currentPosition / 1000.0
        val total = max((duration ?: 0L) / 1000.0, position)
        // While held the times follow the finger. Whole seconds, so the two always add up to the length.
        val shownAt = if (timeline.dragging) timeline.dragAt * total else position
        val left = if (isLive) "LIVE" else formatTime(shownAt, total)
        val right = if (isLive) "" else "-" + formatTime(max(Math.floor(total) - Math.floor(shownAt), 0.0), total)
        if (elapsed.text.toString() != left) elapsed.text = left
        if (remaining.text.toString() != right) remaining.text = right

        if (duration != null) timeline.show(player.currentPosition.toDouble() / duration, player.bufferedPosition.toDouble() / duration)
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

    // The timeline, held: a roster of frames takes its place and the timeline lifts onto it.

    /** The finger is on the timeline at [fraction] of the way along it. */
    private fun scrubbed(fraction: Double, x: Float) {
        if (rosterWanted() && !rosterOpen) openRoster()
        if (rosterOpen) updateRoster(fraction, x)
        refresh()
    }

    /** The finger came up (or the touch was taken): seek, and give the timeline back its place. */
    private fun scrubEnded(fraction: Double, commit: Boolean) {
        if (commit) {
            val duration = player.duration.takeIf { it != C.TIME_UNSET }
            if (duration != null) player.seekTo((duration * fraction).roundToLong())
        }
        closeRoster()
        refresh()
        scheduleHide()
    }

    private fun rosterWanted() = thumbnails?.ready == true && player.duration != C.TIME_UNSET && player.duration > 0

    /** The roster's height: the frame the web's hover preview shows, which is a sixth of the width, 16:9. */
    private fun rosterHeight() = dpf(min(340f, max(168f, widthDp / 6f)) * 9f / 16f)

    private fun trackInset() = dpf(TRACK_INSET_DP * scale)

    private fun openRoster() {
        val frames = thumbnails ?: return
        rosterOpen = true
        timeline.thin = true
        val height = rosterHeight()
        // The roster fills the strip the timeline leaves, and the timeline rests on top of it.
        val rowBottom = column.top + timelineRow.bottom
        roster.lp(height.roundToInt(), panel.height - panel.paddingBottom - rowBottom)
        roster.configure(frames, height)
        roster.visibility = VISIBLE
        roster.alpha = 0f
        roster.translationY = dpf(6f)
        roster.animate().alpha(1f).translationY(0f).setDuration(200).start()
        timelineRow.animate().translationY(-(height - trackInset())).setDuration(180).start()
        label.visibility = VISIBLE
        label.alpha = 0f
        label.animate().alpha(1f).setDuration(150).start()
    }

    private fun closeRoster() {
        if (!rosterOpen) return
        rosterOpen = false
        timeline.thin = false
        roster.animate().cancel()
        roster.visibility = GONE
        timelineRow.animate().translationY(0f).setDuration(180).start()
        label.animate().cancel()
        label.visibility = GONE
    }

    private fun updateRoster(fraction: Double, pointerX: Float = timeline.pointerX) {
        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: return
        val time = fraction * duration / 1000.0
        // The marker sits under the finger, in the roster's own coordinates.
        val at = IntArray(2).also { timeline.getLocationInWindow(it) }
        val here = IntArray(2).also { roster.getLocationInWindow(it) }
        val markerX = (pointerX + at[0] - here[0]).coerceIn(0f, roster.width.toFloat())
        roster.show(time, markerX, duration / 1000.0)
        label.text = formatTime(time, duration / 1000.0)
        // The label rides above the lifted timeline, centred on the finger and kept inside the panel.
        val rowTop = column.top + timelineRow.top
        val lifted = rowTop - (rosterHeight() - trackInset())
        label.measure(MeasureSpec.UNSPECIFIED, MeasureSpec.UNSPECIFIED)
        val half = label.measuredWidth / 2f
        val centreX = (pointerX + at[0] - panelLocationX()).coerceIn(half + dpf(8f), max(half + dpf(8f), panel.width - half - dpf(8f)))
        (label.layoutParams as LayoutParams).apply {
            leftMargin = (centreX - half - panel.paddingLeft).roundToInt()
            bottomMargin = (panel.height - panel.paddingBottom - lifted + dpf(LABEL_GAP_DP * scale)).roundToInt()
        }
        label.requestLayout()
    }

    private fun panelLocationX() = IntArray(2).also { panel.getLocationInWindow(it) }[0]

    // Auto-hide: three seconds, only while playing and with nothing open or being dragged.

    private fun canHide() = !menuOpen && !timeline.dragging && !Util.shouldShowPlayButton(player)

    private fun scheduleHide() {
        main.removeCallbacks(hide)
        if (attached && canHide()) main.postDelayed(hide, AUTO_HIDE_MS)
    }

    private fun setShown(show: Boolean) {
        shown = show
        // In its small window the picture has no controls; they come back with full-screen.
        if (inPictureInPicture) return
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

    private fun audioTracks() = audioChoicesOf(player.currentTracks)

    private fun openAudioMenu() {
        val choices = audioTracks()
        openMenu(audioButton, texts.audioMenu, choices.map { it.label to it.selected }) { index -> selectAudio(player, choices[index]) }
    }

    private fun openSubtitlesMenu() {
        val choices = subtitleChoicesOf(player.currentTracks)
        val off = C.TRACK_TYPE_TEXT in player.trackSelectionParameters.disabledTrackTypes || choices.none { it.selected }
        val rows = listOf(texts.subtitlesOff to off) + choices.map { it.label to (!off && it.selected) }
        openMenu(subtitlesButton, texts.subtitlesMenu, rows) { index -> selectSubtitle(player, if (index == 0) null as SubtitleChoice? else choices[index - 1]) }
    }

    private fun openRateMenu() {
        val current = player.playbackParameters.speed
        openMenu(rateButton, texts.playbackRate, RATES.map { "${formatRate(it)}x" to (kotlin.math.abs(it - current) < 0.01f) }) { index ->
            player.setPlaybackSpeed(RATES[index])
        }
    }

    /** The skin's card: dark, titled, the chosen row ticked, opening above the button that opened it. */
    private fun openMenu(anchor: View, title: String, choices: List<Pair<String, Boolean>>, pick: (Int) -> Unit) {
        closeMenu()
        if (choices.isEmpty()) return
        val card = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(CARD)
                cornerRadius = dpf(14f * scale)
                setStroke(1.dp, 0x1FFFFFFF)
            }
            elevation = dpf(10f)
            setPadding(dpf(4f * scale).toInt(), dpf(4f * scale).toInt(), dpf(4f * scale).toInt(), dpf(4f * scale).toInt())
        }
        card.addView(
            TextView(context).apply {
                text = title.uppercase()
                setTextSize(TypedValue.COMPLEX_UNIT_DIP, 11f * scale)
                typeface = Typeface.DEFAULT_BOLD
                letterSpacing = 0.06f
                setTextColor(0x99FFFFFF.toInt())
                setPadding(dpf(10f * scale).toInt(), dpf(6f * scale).toInt(), dpf(10f * scale).toInt(), dpf(4f * scale).toInt())
            },
            LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
        )
        choices.forEachIndexed { index, (name, selected) ->
            card.addView(
                LinearLayout(context).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dpf(10f * scale).toInt(), dpf(10f * scale).toInt(), dpf(10f * scale).toInt(), dpf(10f * scale).toInt())
                    background = GradientDrawable().apply {
                        setColor(if (selected) 0x1FFFFFFF else Color.TRANSPARENT)
                        cornerRadius = dpf(9f * scale)
                    }
                    addView(
                        TextView(context).apply {
                            text = name
                            setTextSize(TypedValue.COMPLEX_UNIT_DIP, 14f * scale)
                            setTextColor(Color.WHITE)
                            if (selected) typeface = Typeface.DEFAULT_BOLD
                        },
                        LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f),
                    )
                    if (selected) {
                        addView(
                            Icon(context, V10Icons.check).apply { iconDp = 18f * scale },
                            LinearLayout.LayoutParams(dpf(18f * scale).toInt(), dpf(18f * scale).toInt()).apply { marginStart = dpf(12f * scale).toInt() },
                        )
                    }
                    contentDescription = name
                    isSelected = selected
                    isClickable = true
                    setOnClickListener {
                        pick(index)
                        closeMenu()
                    }
                },
                LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
            )
        }
        card.measure(MeasureSpec.makeMeasureSpec(dpf(MENU_WIDTH_DP * scale).toInt(), MeasureSpec.EXACTLY), MeasureSpec.UNSPECIFIED)
        val where = IntArray(2).also { anchor.getLocationInWindow(it) }
        val here = IntArray(2).also { getLocationInWindow(it) }
        val width = card.measuredWidth
        val height = card.measuredHeight
        val centreX = where[0] - here[0] + anchor.width / 2
        // Centred on its button, above it, and kept inside the controls.
        val left = (centreX - width / 2).coerceIn(dpf(8f).toInt(), max(dpf(8f).toInt(), this.width - width - dpf(8f).toInt()))
        val top = (where[1] - here[1] - height - dpf(4f)).toInt().coerceAtLeast(dpf(8f).toInt())
        menuLayer.addView(card, LayoutParams(width, WRAP_CONTENT).apply {
            leftMargin = left
            topMargin = top
        })
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

    // Layout.

    /**
     * The skin's `--lmpl-s`: one up to 900 dp wide, then 1.25, then 1.6, so the controls do not look
     * like a stamp on a tablet. Everything here is sized from it, as the web's CSS is.
     */
    private fun applyScale() {
        scale = when {
            widthDp >= 1400f -> 1.6f
            widthDp >= 900f -> 1.25f
            else -> 1f
        }
        val s = scale
        fun px(dp: Float) = dpf(dp * s).roundToInt()
        play.iconDp = 38f * s
        back?.skipDp = 32f * s
        forward?.skipDp = 32f * s
        // The cluster is centred, with 32 dp between its parts: the skips 56 dp round, play 80.
        for (i in 0 until centre.childCount) {
            val child = centre.getChildAt(i)
            val size = if (child === back || child === forward) 56f else 80f
            child.layoutParams = LinearLayout.LayoutParams(px(size), px(size)).apply {
                if (i > 0) marginStart = px(32f)
                gravity = Gravity.CENTER_VERTICAL
            }
        }
        listOf(muteButton, audioButton, rateButton, subtitlesButton, pipButton, exitButton).forEach {
            it.iconDp = 22f * s
            it.lp(px(40f), px(40f), margin = 1)
        }
        timeline.lp(px(30f))
        timeline.scale = s
        listOf(elapsed, remaining).forEach {
            it.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f * s)
            it.minWidth = dpf(40f * s).toInt()
        }
        elapsed.layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, px(30f)).apply { marginEnd = px(12f) }
        remaining.layoutParams = LinearLayout.LayoutParams(WRAP_CONTENT, px(30f)).apply { marginStart = px(12f) }
        timelineRow.layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, px(30f))
        actionsRow.layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply {
            // The buttons' own padding keeps their glyphs on the line of the timeline's ends.
            marginStart = -px(8f)
            marginEnd = -px(8f)
        }
        val edge = edgePx()
        column.setPadding(edge, px(12f) + px(72f), edge, px(14f))
        label.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 14f * s)
        label.setPadding(px(11f), px(4f), px(11f), px(4f))
        label.background = GradientDrawable().apply {
            setColor(0xB8141418.toInt())
            cornerRadius = dpf(40f)
            setStroke(1.dp, 0x29FFFFFF)
        }
        timelineRow.translationY = 0f
        requestLayout()
    }

    /** `--lmpl-edge`: how far the controls keep in from the sides. */
    private fun edgePx(): Int {
        val w = widthDp
        val dp = when {
            widthDp >= 1400f -> (w * 0.06f).coerceIn(56f, 200f)
            widthDp >= 900f -> (w * 0.05f).coerceIn(32f, 110f)
            else -> (w * 0.05f).coerceIn(20f, 64f)
        }
        return dpf(dp).roundToInt()
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

    /** Tapping a control closes an open menu, as the skin's menus close when they lose focus. */
    private fun Icon.tap(action: () -> Unit) = apply {
        isClickable = true
        setOnClickListener {
            if (menuOpen) closeMenu()
            action()
        }
    }

    private fun timeView(gravity: Int) = TextView(context).apply {
        setTextColor(Color.WHITE)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        fontFeatureSettings = "tnum"
        this.gravity = gravity
        setShadowLayer(dpf(2f), 0f, dpf(1f), 0x99000000.toInt())
    }

    private fun dpf(value: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

    private val Int.dp: Int get() = dpf(this.toFloat()).roundToInt()

    private fun formatRate(rate: Float) = if (rate == rate.toInt().toFloat()) rate.toInt().toString() else "%.2f".format(rate).trimEnd('0').trimEnd('.')

    companion object {
        /** The skin's `playbackRates`. */
        val RATES = listOf(0.5f, 0.7f, 1f, 1.5f)
        const val AUTO_HIDE_MS = 3000L
        const val FADE_IN_MS = 100L
        const val FADE_OUT_MS = 500L
        private const val TICK_MS = 250L
        private const val MENU_WIDTH_DP = 168
        private const val CARD = 0xF718181B.toInt()

        /** The slider is taller than the track it draws, so the track sits this far (per unit of scale) above its bottom. */
        private const val TRACK_INSET_DP = 12.5f
        private const val LABEL_GAP_DP = 8f
    }
}

/** The skip button's glyph: a circular arrow with the interval written in it; the arrow, never the number, mirrors. */
private class Skip(val seconds: Int, val forward: Boolean)

/** The dark fade the controls sit on: opaque at the bottom edge, gone by the top of the column. */
private class FadeDrawable : Drawable() {
    private val paint = Paint()
    override fun onBoundsChange(bounds: Rect) {
        paint.shader = LinearGradient(
            0f, bounds.bottom.toFloat(), 0f, bounds.top.toFloat(),
            intArrayOf(0xBF000000.toInt(), 0x66000000, 0x00000000),
            floatArrayOf(0f, 0.55f, 1f),
            Shader.TileMode.CLAMP,
        )
    }

    override fun draw(canvas: Canvas) = canvas.drawRect(bounds, paint)

    override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
}

/**
 * The timeline: thick and round with no thumb, the fill being the playhead. Tall enough to hit
 * ([lp] sets 30 dp), the track grows a little while held, and thins when a roster takes its place
 * under it. A touch seeks on lifting, as the web's does, and tells the controls where it is while held.
 */
@SuppressLint("ViewConstructor", "ClickableViewAccessibility")
private class Timeline(
    context: Context,
    private val onScrub: (Double, Float) -> Unit,
    private val onEnd: (Double, Boolean) -> Unit,
    private val onTouch: () -> Unit,
) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var played = 0.0
    private var buffered = 0.0
    var scale = 1f
    var dragging = false
        private set
    var dragAt = 0.0
        private set
    var pointerX = 0f
        private set

    /** The roster is under the timeline: the track is as thin as the skin's `5px`. */
    var thin = false
        set(value) {
            field = value
            invalidate()
        }

    fun lp(height: Int) {
        layoutParams = LinearLayout.LayoutParams(0, height, 1f)
    }

    fun show(played: Double, buffered: Double) {
        if (dragging) return
        this.played = played.coerceIn(0.0, 1.0)
        this.buffered = buffered.coerceIn(0.0, 1.0)
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val dp = when {
            thin -> 5f
            dragging -> 16f
            else -> 12f
        } * scale
        val thickness = density * dp
        // The track rests on the bottom of the slider's drawn area: 12.5 dp up from its bottom edge.
        val top = (height - thickness) / 2
        val radius = thickness / 2
        fun bar(fraction: Double, color: Int) {
            paint.color = color
            canvas.drawRoundRect(RectF(0f, top, max((width * fraction).toFloat(), 0f), top + thickness), radius, radius, paint)
        }
        bar(1.0, 0x42FFFFFF)
        bar(buffered, 0x66FFFFFF)
        bar(if (dragging) dragAt else played, Color.WHITE)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (width == 0) return false
        val fraction = (event.x / width).toDouble().coerceIn(0.0, 1.0)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                onTouch()
                parent.requestDisallowInterceptTouchEvent(true)
                dragging = true
                dragAt = fraction
                pointerX = event.x.coerceIn(0f, width.toFloat())
                onScrub(fraction, pointerX)
            }
            MotionEvent.ACTION_MOVE -> {
                dragAt = fraction
                pointerX = event.x.coerceIn(0f, width.toFloat())
                onScrub(fraction, pointerX)
            }
            MotionEvent.ACTION_UP -> {
                dragging = false
                played = fraction
                onEnd(fraction, true)
            }
            MotionEvent.ACTION_CANCEL -> {
                dragging = false
                onEnd(fraction, false)
            }
        }
        invalidate()
        return true
    }
}

/**
 * The frames under a held timeline: a strip that slides past a marker kept under the finger, with
 * those further from it falling away into the dark, so it reads as a lens on the playhead. Drawn from
 * [Thumbnails]' sheets; a frame whose sheet has not arrived is left dark.
 */
private class RosterView(context: Context) : View(context) {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG)
    private var frames: Thumbnails? = null
    private var tileHeight = 0f
    private var time = 0.0
    private var markerX = 0f
    private var duration = 0.0

    fun configure(frames: Thumbnails, height: Float) {
        this.frames = frames
        tileHeight = height
    }

    fun lp(height: Int, bottom: Int) {
        layoutParams = FrameLayout.LayoutParams(MATCH_PARENT, height, Gravity.BOTTOM).apply { bottomMargin = bottom }
    }

    fun show(time: Double, markerX: Float, duration: Double) {
        this.time = time
        this.markerX = markerX
        this.duration = duration
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val frames = frames ?: return
        val density = resources.displayMetrics.density
        val w = width.toFloat()
        val h = height.toFloat()
        // Not `drawColor`: the parents do not clip, so that would fill the whole screen.
        paint.color = 0xFF0B0B0D.toInt()
        canvas.drawRect(0f, 0f, w, h, paint)
        canvas.save()
        canvas.clipRect(0f, 0f, w, h)
        val sample = frames.sample() ?: run { canvas.restore(); return }
        val tileWidth = max(24f * density, tileHeight * sample.w / sample.h)
        val step = Roster.step(duration)
        val dst = RectF()
        val src = Rect()
        for (tile in Roster.tiles(time, markerX, w, tileWidth, step, duration)) {
            dst.set(tile.left, 0f, tile.left + tileWidth, h)
            paint.color = 0xFF151518.toInt()
            canvas.drawRect(dst, paint)
            val cue = frames.cueAt(tile.time) ?: continue
            frames.sheet(cue)?.let { sheet ->
                src.set(cue.x, cue.y, cue.x + cue.w, cue.y + cue.h)
                canvas.drawBitmap(sheet, src, dst, paint)
            }
            // A frame apart from its neighbour, without a gutter.
            paint.color = 0x8C000000.toInt()
            canvas.drawRect(dst.right - density, 0f, dst.right, h, paint)
        }
        // The frames nearest the marker are the ones that matter: the rest fall away.
        fun at(x: Float) = (x / w).coerceIn(0f, 1f)
        val stops = floatArrayOf(0f, at(markerX - 0.22f * w), at(markerX - 0.08f * w), at(markerX + 0.08f * w), at(markerX + 0.22f * w), 1f)
        for (i in 1 until stops.size) stops[i] = max(stops[i], stops[i - 1])
        paint.shader = LinearGradient(
            0f, 0f, w, 0f,
            intArrayOf(0xC7080A0A.toInt(), 0x59080A0A, 0x00080A0A, 0x00080A0A, 0x59080A0A, 0xC7080A0A.toInt()),
            stops,
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, w, h, paint)
        paint.shader = LinearGradient(
            0f, 0f, 0f, h,
            intArrayOf(0x47000000, 0x00000000, 0x00000000, 0x66000000),
            floatArrayOf(0f, 0.35f, 0.7f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(0f, 0f, w, h, paint)
        paint.shader = null
        // A hairline of light where the timeline rests on the strip.
        paint.color = 0x24FFFFFF
        canvas.drawRect(0f, 0f, w, density, paint)
        // The marker: a rounded white bar with an outline and a glow.
        val bar = 3f * density
        line.color = 0x66000000
        canvas.drawRoundRect(RectF(markerX - bar / 2 - density, 0f, markerX + bar / 2 + density, h), bar, bar, line)
        line.color = Color.WHITE
        line.setShadowLayer(14f * density, 0f, 0f, 0x8CFFFFFF.toInt())
        canvas.drawRoundRect(RectF(markerX - bar / 2, 0f, markerX + bar / 2, h), bar, bar, line)
        line.clearShadowLayer()
        canvas.restore()
    }
}

/**
 * One of the skin's controls: a Video.js 10 icon drawn from its path layers, or the skip glyph, in a
 * round dark button when [circle]. Pressing shrinks it a touch, as the web's does.
 */
@SuppressLint("ViewConstructor")
private class Icon(context: Context, layers: List<V10Icons.Layer>?, private val circle: Boolean = false) : View(context) {
    var layers = layers
        set(value) {
            if (field === value) return
            field = value
            paths = null
            invalidate()
        }
    var skip: Skip? = null
    var label = ""
    var iconDp = 22f
        set(value) {
            if (field == value) return
            field = value
            paths = null
            invalidate()
        }
    var skipDp = 32f

    private var paths: List<Triple<Path, Float, Float>>? = null
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val disc = Paint(Paint.ANTI_ALIAS_FLAG)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textAlign = Paint.Align.CENTER
        typeface = Typeface.DEFAULT_BOLD
    }

    fun lp(width: Int, height: Int, margin: Int = 0) {
        layoutParams = LinearLayout.LayoutParams(width, height).apply {
            if (margin > 0) {
                marginStart = margin
                marginEnd = margin
            }
            gravity = Gravity.CENTER_VERTICAL
        }
    }

    override fun setPressed(pressed: Boolean) {
        super.setPressed(pressed)
        animate().scaleX(if (pressed) 0.94f else 1f).scaleY(if (pressed) 0.94f else 1f).setDuration(120).start()
    }

    override fun onDraw(canvas: Canvas) {
        val density = resources.displayMetrics.density
        val cx = width / 2f
        val cy = height / 2f
        if (circle) {
            disc.color = 0x9418181B.toInt()
            canvas.drawCircle(cx, cy, min(width, height) / 2f - density, disc)
            ring.color = 0x2EFFFFFF
            ring.strokeWidth = density
            canvas.drawCircle(cx, cy, min(width, height) / 2f - density, ring)
        }
        val size = iconDp * density
        skip?.let { drawSkip(canvas, it, cx, cy, skipDp * density); return }
        val list = layers ?: return
        val unit = size / V10Icons.GRID
        val built = paths ?: list.map { layer ->
            Triple(PathParser.createPathFromPathData(layer.path), layer.alpha, layer.strokeWidth)
        }.also { paths = it }
        // Legible over any picture, as the skin's drop shadow makes it.
        fill.setShadowLayer(size * 0.05f, 0f, size * 0.04f, 0x99000000.toInt())
        stroke.setShadowLayer(size * 0.05f, 0f, size * 0.04f, 0x99000000.toInt())
        canvas.save()
        canvas.translate(cx - size / 2, cy - size / 2)
        canvas.scale(unit, unit)
        for ((path, alpha, strokeWidth) in built) {
            if (strokeWidth > 0f) {
                stroke.color = Color.argb((alpha * 255).roundToInt(), 255, 255, 255)
                stroke.strokeWidth = strokeWidth
                canvas.drawPath(path, stroke)
            } else {
                fill.color = Color.argb((alpha * 255).roundToInt(), 255, 255, 255)
                canvas.drawPath(path, fill)
            }
        }
        canvas.restore()
    }

    /** `skipIcon` in `controlsHtml.ts`, on its 24-unit grid. */
    private fun drawSkip(canvas: Canvas, skip: Skip, cx: Float, cy: Float, size: Float) {
        val unit = size / 24f
        val arc = if (skip.forward) "M20.5 12a8.5 8.5 0 1 1-2.9-6.4" else "M3.5 12a8.5 8.5 0 1 0 2.9-6.4"
        val head = if (skip.forward) "M20.8 4.2v4.4h-4.4" else "M3.2 4.2v4.4h4.4"
        stroke.color = Color.WHITE
        stroke.strokeWidth = 1.8f
        stroke.setShadowLayer(size * 0.04f, 0f, size * 0.03f, 0x66000000)
        canvas.save()
        canvas.translate(cx - size / 2, cy - size / 2)
        canvas.scale(unit, unit)
        canvas.drawPath(PathParser.createPathFromPathData(arc), stroke)
        canvas.drawPath(PathParser.createPathFromPathData(head), stroke)
        text.color = Color.WHITE
        text.textSize = if (skip.seconds >= 100) 6f else 7.5f
        canvas.drawText(skip.seconds.toString(), 12f, 15.2f, text)
        canvas.restore()
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
        val side = min(width, height) * 0.6f
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
