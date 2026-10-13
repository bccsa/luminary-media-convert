package org.bccsa.luminary.player.engine

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Region
import android.text.TextUtils
import android.graphics.Shader
import android.graphics.Typeface
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.FrameLayout
import android.widget.HorizontalScrollView
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.OptIn
import androidx.core.content.ContextCompat
import androidx.core.graphics.Insets
import androidx.core.graphics.PathParser
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong
import org.bccsa.luminary.player.Browse
import org.bccsa.luminary.player.BrowseChapter
import org.bccsa.luminary.player.BrowseItem
import org.bccsa.luminary.player.Roster
import org.bccsa.luminary.player.Thumbnails

/**
 * The full-screen controls, drawn to `player-web`'s Video.js 10 skin (`styles.css`): the skip circles
 * either side of a round play / pause in the middle; under them the timeline, with the time played
 * before it and the time left after it; and under that one row of buttons, the settings at the left
 * and picture in picture and leaving full-screen at the right. A dark fade rises from the bottom edge
 * so white controls read over a bright picture.
 *
 * Holding the timeline opens a roster of frames over the buttons and lifts the timeline onto
 * it, thicker, so the frames around the playhead can be seen as it is dragged ([Thumbnails] has them).
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
    /** Opens the list of Cast devices; no button when null. */
    private val onCast: (() -> Unit)? = null,
    /** The scrub frames; no roster when null or empty. */
    private val thumbnails: Thumbnails? = null,
    /** The chapters and up next the panel lists; no button while there are none. */
    browse: Browse? = null,
    /** Called with the id of the up-next item the viewer picked. */
    private val onBrowseSelect: ((String) -> Unit)? = null,
    /** The strip near the end: the id of the video picked, or null when the viewer closes it. */
    private val onNextUp: ((String?) -> Unit)? = null,
    /** Loads the up-next pictures; the rows keep a plain tile without it. */
    private val images: BitmapLoader? = null,
    private val onLeave: () -> Unit,
) : FrameLayout(context), Player.Listener {
    private val main = Handler(Looper.getMainLooper())
    private val panel = FrameLayout(context)
    private val menuLayer = FrameLayout(context)
    private val browseLayer = FrameLayout(context)
    private val nextUpLayer = FrameLayout(context)

    private val play = Icon(context, V10Icons.play, circle = true)
    private val spinner = Spinner(context)
    private val back: Icon?
    private val forward: Icon?
    private val qualityButton = Icon(context, V10Icons.quality)
    private val audioButton = Icon(context, SettingIcons.language)
    private val pipButton = Icon(context, V10Icons.pip)
    private val castButton = Icon(context, V10Icons.cast)
    private val subtitlesButton = Icon(context, V10Icons.captions)
    private val browseButton = Icon(context, BrowseIcons.list)
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
    private val chapterNow = TextView(context)
    private val fade = FadeDrawable()

    private var volumeBeforeMute = 1f
    /** The right-hand time shows the whole length instead of what is left, as the web's does when pressed. */
    private var showTotal = false
    private var inPictureInPicture = false
    private var menuOpen = false
    private var browse: Browse? = browse?.takeUnless { it.isEmpty }
    private var browseOpen = false
    private var nextUp: List<BrowseItem> = browse?.nextUp.orEmpty().take(NextUp.MAX)
    /** Chosen or closed: either way the strip has done its job for this video. */
    private var nextUpClosed = false
    private var nextUpOn = false
    private var nextUpStrip: LinearLayout? = null
    private var browseTab = BrowseTab.CHAPTERS
    private var browseSheet: LinearLayout? = null
    private var browseScroll: ScrollView? = null
    private var chapterRows: List<ChapterRow> = emptyList()
    private var currentChapter = -1
    private val loadingImages = mutableListOf<ListenableFuture<Bitmap>>()
    private var inset = Insets.NONE
    private var shown = true
    private var attached = false
    private var safe = Insets.NONE
    private var rosterOpen = false
    /** The time the strip is held at by a finger on it (the slow scrub), until it lifts. */
    private var sliding: Double? = null
    private var closedByThisTouch = false
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
            // The press that put the roster away was for that, not for the controls.
            if (closedByThisTouch) return true
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
        remaining.isClickable = true
        remaining.setOnClickListener {
            showTotal = !showTotal
            refresh()
            scheduleHide()
        }
        chapterNow.apply {
            setTextColor(Color.WHITE)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            setShadowLayer(dpf(2f), 0f, dpf(1f), 0xB3000000.toInt())
            visibility = GONE
        }
        column.addView(chapterNow)
        column.addView(timelineRow)
        actionsRow.addView(muteButton.tap { toggleMute() })
        actionsRow.addView(qualityButton.tap { openQualityMenu() })
        actionsRow.addView(audioButton.tap { openAudioMenu() })
        actionsRow.addView(rateButton.tap { openRateMenu() })
        actionsRow.addView(subtitlesButton.tap { openSubtitlesMenu() })
        actionsRow.addView(browseButton.tap { if (browseOpen) closeBrowse() else openBrowse() })
        actionsRow.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        actionsRow.addView(castButton.tap { onCast?.invoke() })
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
        qualityButton.contentDescription = texts.qualityMenu
        audioButton.contentDescription = texts.audioMenu
        rateButton.contentDescription = texts.playbackRate
        muteButton.contentDescription = texts.mute
        pipButton.contentDescription = texts.pictureInPicture
        subtitlesButton.contentDescription = texts.subtitlesMenu
        browseButton.contentDescription = texts.browse
        browseButton.visibility = if (this.browse != null) VISIBLE else GONE
        pipButton.visibility = if (onPictureInPicture != null) VISIBLE else GONE
        castButton.contentDescription = texts.cast
        castButton.visibility = if (onCast != null) VISIBLE else GONE
        spinner.contentDescription = texts.loading
        exitButton.contentDescription = texts.exitFullscreen
        timeline.contentDescription = texts.seek
        addView(menuLayer, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // Under the panel, over the controls, which it rides above while they show.
        addView(nextUpLayer, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        addView(browseLayer, LayoutParams(MATCH_PARENT, MATCH_PARENT))
        // The controls stay clear of the system's own edges.
        ViewCompat.setOnApplyWindowInsetsListener(this) { _, insets ->
            safe = safeInsets(insets)
            padClearOfSystem()
            insets
        }
        addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> padClearOfSystem() }
        thumbnails?.onChange = {
            roster.invalidate()
            if (rosterOpen) updateRoster(rosterTime)
        }
        roster.onSlide = { time ->
            sliding = time
            updateRoster(time)
            refresh()
        }
        roster.onSlideEnd = { commit ->
            sliding?.let { if (commit) player.seekTo((it * 1000).roundToLong()) }
            sliding = null
            refresh()
            scheduleHide()
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
        cancelImages()
        super.onDetachedFromWindow()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        val dp = w / resources.displayMetrics.density
        if (dp != widthDp) {
            widthDp = dp
            applyScale()
            // Not inside this layout pass: the sheet is rebuilt for the new width.
            if (browseOpen) post { if (browseOpen) renderBrowse(keepScroll = true) }
        }
    }

    // Touch: only what the controls did not take.

    override fun onTouchEvent(event: MotionEvent): Boolean = gestures.onTouchEvent(event)

    /** A press anywhere but the roster and the timeline puts the roster away. */
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            closedByThisTouch = rosterOpen && !hits(roster, event) && !hits(timeline, event)
            if (closedByThisTouch) closeRoster()
        }
        return super.dispatchTouchEvent(event)
    }

    private fun hits(view: View, event: MotionEvent): Boolean {
        val at = IntArray(2).also { view.getLocationOnScreen(it) }
        return event.rawX >= at[0] && event.rawX <= at[0] + view.width && event.rawY >= at[1] && event.rawY <= at[1] + view.height
    }

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
        if (active) {
            closeMenu()
            closeBrowse()
        } else {
            setShown(true)
        }
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
        // With one tier there is nothing to choose.
        qualityButton.visibility = if (qualityChoicesOf(player.currentTracks, heldQuality(player)).size > 1) VISIBLE else GONE
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
        val shownAt = sliding ?: if (timeline.dragging) timeline.dragAt * total else position
        val left = if (isLive) "LIVE" else formatTime(shownAt, total)
        val right = when {
            isLive -> ""
            showTotal -> formatTime(total, total)
            else -> "-" + formatTime(max(Math.floor(total) - Math.floor(shownAt), 0.0), total)
        }
        if (elapsed.text.toString() != left) elapsed.text = left
        if (remaining.text.toString() != right) remaining.text = right

        if (duration != null) {
            val at = sliding?.let { it * 1000 } ?: player.currentPosition.toDouble()
            timeline.show(at / duration, player.bufferedPosition.toDouble() / duration)
        }
        showChapterNow(position, duration?.div(1000.0) ?: 0.0)
        updateNextUp()
        if (browseOpen && browseTab == BrowseTab.CHAPTERS) markCurrentChapter()
        // Held open after the finger lifts, the roster follows the playhead until it is touched again.
        if (rosterOpen && !timeline.dragging && sliding == null) updateRoster(position)
    }

    // The strip of next videos, offered near the end.

    /** Opens or puts away the strip as the playhead and the panel say; called as the state changes. */
    private fun updateNextUp() {
        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 }?.div(1000.0)
        val due = !browseOpen && !inPictureInPicture &&
            NextUp.due(nextUp.isNotEmpty(), nextUpClosed, player.isCurrentMediaItemLive, duration, player.currentPosition / 1000.0)
        if (due == nextUpOn) return
        nextUpOn = due
        if (due) showNextUp() else removeNextUp()
    }

    private fun removeNextUp() {
        nextUpOn = false
        nextUpStrip = null
        nextUpLayer.removeAllViews()
    }

    /** Directly above the timeline (and the chapter line over it) while the controls show, on the bottom edge when they do not. */
    private fun raiseNextUp() {
        val strip = nextUpStrip ?: return
        val raise = if (shown) {
            val chapter = if (chapterNow.visibility == VISIBLE) chapterNow.height + (chapterNow.layoutParams as? MarginLayoutParams)?.bottomMargin.let { it ?: 0 } else 0
            (column.paddingBottom + actionsRow.height + timelineRow.height + chapter + dpf(8f * scale) - dpf(16f * scale)).coerceAtLeast(0f)
        } else {
            0f
        }
        strip.animate().translationY(-raise).setDuration(NEXT_UP_MS).start()
    }

    private fun closeNextUp() {
        if (nextUpClosed) return
        nextUpClosed = true
        removeNextUp()
        onNextUp?.invoke(null)
    }

    private fun chooseNextUp(id: String) {
        if (nextUpClosed) return
        nextUpClosed = true
        removeNextUp()
        onNextUp?.invoke(id)
    }

    private fun showNextUp() {
        fun px(dp: Float) = dpf(dp * scale).roundToInt()
        val edge = edgePx()
        val head = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL or Gravity.END
            addView(
                TextView(context).apply {
                    text = texts.upNext
                    setTextSize(TypedValue.COMPLEX_UNIT_DIP, 16f * scale)
                    typeface = Typeface.DEFAULT_BOLD
                    setTextColor(Color.WHITE)
                    setShadowLayer(dpf(2f), 0f, dpf(1f), 0x80000000.toInt())
                },
            )
            addView(
                Icon(context, BrowseIcons.close).apply {
                    iconDp = 20f * scale
                    contentDescription = texts.dismiss
                    isClickable = true
                    setOnClickListener { closeNextUp() }
                    lp(px(36f), px(36f), margin = 0)
                },
                LinearLayout.LayoutParams(px(36f), px(36f)).apply { marginStart = px(4f) },
            )
        }
        // The frames of the scrub strip, in size and shape: a sixth of the width, 16:9.
        val frameHeight = rosterHeight().roundToInt()
        val frameWidth = frameHeight * 16 / 9
        val frames = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            // Right-aligned while they all fit; the scroll view takes over when they do not.
            gravity = Gravity.END
        }
        nextUp.forEach { item ->
            val picture = ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            loadImage(picture, item.imageUrl, item.fallbackImageUrl)
            // The name over the foot of the frame, as the scrub strip puts its timecode.
            val caption = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.BOTTOM
                setPadding(px(8f), px(16f), px(8f), px(6f))
                background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0xD9000000.toInt(), Color.TRANSPARENT))
                item.section?.takeIf { it.isNotEmpty() }?.let { section ->
                    addView(
                        TextView(context).apply {
                            text = section.uppercase()
                            setTextSize(TypedValue.COMPLEX_UNIT_DIP, 10f * scale)
                            typeface = Typeface.DEFAULT_BOLD
                            letterSpacing = 0.06f
                            setTextColor(0xBFFFFFFF.toInt())
                            maxLines = 1
                            ellipsize = TextUtils.TruncateAt.END
                        },
                    )
                }
                addView(
                    TextView(context).apply {
                        text = item.title
                        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f * scale)
                        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                        setTextColor(Color.WHITE)
                        maxLines = 2
                        ellipsize = TextUtils.TruncateAt.END
                    },
                )
            }
            val frame = FrameLayout(context).apply {
                background = GradientDrawable().apply {
                    setColor(0xFF151518.toInt())
                    cornerRadius = dpf(6f * scale)
                    setStroke(1.dp, 0x29FFFFFF)
                }
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: android.graphics.Outline) =
                        outline.setRoundRect(0, 0, view.width, view.height, dpf(6f * scale))
                }
                isClickable = true
                contentDescription = listOfNotNull(item.section?.takeIf { it.isNotEmpty() }, item.title).joinToString(", ")
                setOnClickListener { chooseNextUp(item.id) }
                addView(picture, LayoutParams(MATCH_PARENT, MATCH_PARENT))
                addView(caption, LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
            }
            frames.addView(frame, LinearLayout.LayoutParams(frameWidth, frameHeight).apply { marginStart = px(8f) })
        }
        val scroller = HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            overScrollMode = OVER_SCROLL_NEVER
            isFillViewport = true
            addView(frames, LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        val strip = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(head, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            addView(scroller, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
            alpha = 0f
        }
        nextUpLayer.addView(
            strip,
            LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM).apply {
                marginStart = edge + inset.left
                marginEnd = edge + inset.right
                bottomMargin = inset.bottom + px(16f)
            },
        )
        nextUpStrip = strip
        strip.animate().alpha(1f).setDuration(NEXT_UP_MS).start()
        // Measured before it can be raised onto the timeline.
        strip.post { raiseNextUp() }
    }

    private var cutsFor: Pair<List<BrowseChapter>, Double>? = null

    /** "Chapter 4 of 7" above the timeline, and the timeline cut at the chapter starts, as the web player does. */
    private fun showChapterNow(position: Double, duration: Double) {
        val chapters = browse?.chapters.orEmpty()
        if (cutsFor?.first !== chapters || cutsFor?.second != duration) {
            cutsFor = chapters to duration
            timeline.cuts = ChapterCuts.starts(chapters, duration)
        }
        val text = ChapterCuts.nowText(texts.chapterOf, chapters, chapterIndex(chapters, position))
        if (chapterNow.text.toString() != text) chapterNow.text = text
        chapterNow.visibility = if (text.isEmpty()) GONE else VISIBLE
        // Held, the strip of frames carries the moment; the line would stack on it.
        chapterNow.alpha = if (timeline.dragging || rosterOpen) 0f else 1f
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
        if (rosterOpen) updateRoster(fraction * (player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: 0L) / 1000.0, x)
        refresh()
    }

    /** The finger came up (or the touch was taken): seek, and give the timeline back its place. */
    private fun scrubEnded(fraction: Double, commit: Boolean) {
        if (commit) {
            val duration = player.duration.takeIf { it != C.TIME_UNSET }
            if (duration != null) player.seekTo((duration * fraction).roundToLong())
        }
        // The roster stays until a press lands outside it and the timeline.
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
        timeline.onRoster = true
        val height = rosterHeight()
        // The roster rises from the bottom edge over the buttons, and the timeline rests on its top.
        val rowBottom = column.top + timelineRow.bottom
        val reach = height + (panel.height - rowBottom)
        roster.lp(reach.roundToInt(), -panel.paddingBottom)
        roster.configure(frames, reach)
        // Nothing but the timeline and the roster stays: the buttons would show through behind the strip.
        for (part in listOf(actionsRow, centre)) {
            part.animate().alpha(0f).setDuration(120).withEndAction { if (rosterOpen) part.visibility = INVISIBLE }.start()
        }
        // The fade that darkens the controls would only dim the strip over them.
        fade.alpha = 0
        column.invalidate()
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
        timeline.onRoster = false
        roster.animate().cancel()
        roster.visibility = GONE
        for (part in listOf(actionsRow, centre)) {
            part.animate().cancel()
            part.visibility = VISIBLE
            part.alpha = 1f
        }
        fade.alpha = 255
        column.invalidate()
        timelineRow.animate().translationY(0f).setDuration(180).start()
        label.animate().cancel()
        label.visibility = GONE
    }

    private var rosterTime = 0.0

    private fun updateRoster(time: Double, pointerX: Float = timeline.pointerX) {
        val duration = player.duration.takeIf { it != C.TIME_UNSET && it > 0 } ?: return
        rosterTime = time
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

    private fun canHide() = !menuOpen && !browseOpen && !timeline.dragging && !rosterOpen && !Util.shouldShowPlayButton(player)

    private fun scheduleHide() {
        main.removeCallbacks(hide)
        if (attached && canHide()) main.postDelayed(hide, AUTO_HIDE_MS)
    }

    private fun setShown(show: Boolean) {
        shown = show
        raiseNextUp()
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

    private fun openQualityMenu() {
        val held = heldQuality(player)
        val choices = qualityChoicesOf(player.currentTracks, held)
        val names = listOf(texts.qualityAuto to (held == null)) + choices.map { "${it.height}p" to it.selected }
        openMenu(qualityButton, texts.qualityMenu, names) { index -> selectQuality(player, choices.getOrNull(index - 1)?.height) }
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

    // The chapters / up-next panel: a sheet down the right-hand side, with the rest of the picture dimmed.

    private enum class BrowseTab { CHAPTERS, UP_NEXT }

    private class ChapterRow(val row: View, val title: TextView, val marker: View)

    /** True while the panel is open. */
    val hasBrowseOpen: Boolean get() = browseOpen

    /** Replaces what the panel lists, also while it is open; with nothing to list the button goes and the panel closes. */
    fun setBrowse(next: Browse?) {
        // A different offer is a different video's: its strip opens again.
        val offer = next?.nextUp.orEmpty().take(NextUp.MAX)
        if (offer.map { it.id } != nextUp.map { it.id }) {
            nextUpClosed = false
            removeNextUp()
        }
        nextUp = offer
        browse = next?.takeUnless { it.isEmpty }
        browseButton.visibility = if (browse != null) VISIBLE else GONE
        if (!browseOpen) return
        if (browse == null) closeBrowse() else renderBrowse(keepScroll = true)
    }

    private fun openBrowse() {
        val lists = browse ?: return
        closeMenu()
        closeRoster()
        browseOpen = true
        updateNextUp()
        browseTab = if (lists.chapters.isNotEmpty()) BrowseTab.CHAPTERS else BrowseTab.UP_NEXT
        main.removeCallbacks(hide)
        renderBrowse(keepScroll = false)
    }

    /** False when the panel was not open, so a back gesture knows whether it was for the panel. */
    fun closeBrowse(): Boolean {
        if (!browseOpen) return false
        browseOpen = false
        updateNextUp()
        cancelImages()
        browseLayer.removeAllViews()
        browseSheet = null
        browseScroll = null
        chapterRows = emptyList()
        currentChapter = -1
        scheduleHide()
        return true
    }

    private fun browseWidthPx(): Int {
        // A third of a landscape screen is enough for a list; a portrait one needs nearly all of its width.
        val wide = (width * BROWSE_FRACTION).roundToInt()
        val floor = min(dpf(BROWSE_MIN_DP * scale).roundToInt(), (width * 0.92f).roundToInt())
        return max(wide, floor)
    }

    private fun renderBrowse(keepScroll: Boolean) {
        val lists = browse ?: return
        val keep = if (keepScroll) browseScroll?.scrollY ?: 0 else 0
        cancelImages()
        browseLayer.removeAllViews()
        if (lists.chapters.isEmpty()) browseTab = BrowseTab.UP_NEXT else if (lists.upNext.isEmpty()) browseTab = BrowseTab.CHAPTERS
        fun px(dp: Float) = dpf(dp * scale).roundToInt()

        // Anywhere outside the sheet puts it away; the scrim also keeps those taps from the controls beneath.
        browseLayer.addView(
            View(context).apply {
                setBackgroundColor(0x4D000000)
                isClickable = true
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
                setOnClickListener { closeBrowse() }
            },
            LayoutParams(MATCH_PARENT, MATCH_PARENT),
        )
        val sheet = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = GradientDrawable().apply {
                setColor(BROWSE_SHEET)
                cornerRadii = floatArrayOf(dpf(16f * scale), dpf(16f * scale), 0f, 0f, 0f, 0f, dpf(16f * scale), dpf(16f * scale))
            }
            elevation = dpf(12f)
            isClickable = true
            ViewCompat.setAccessibilityPaneTitle(this, texts.browse)
            setPadding(0, inset.top, inset.right, inset.bottom)
        }
        val header = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(px(8f), px(4f), px(4f), 0)
        }
        fun tab(label: String, which: BrowseTab) = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            val selected = browseTab == which
            addView(
                TextView(context).apply {
                    text = label
                    setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15f * scale)
                    typeface = if (selected) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                    setTextColor(if (selected) Color.WHITE else 0x99FFFFFF.toInt())
                    setPadding(px(12f), px(12f), px(12f), px(8f))
                },
            )
            addView(
                View(context).apply { setBackgroundColor(if (selected) Color.WHITE else Color.TRANSPARENT) },
                LinearLayout.LayoutParams(MATCH_PARENT, dpf(2f).roundToInt()),
            )
            contentDescription = label
            isSelected = selected
            isClickable = true
            setOnClickListener {
                browseTab = which
                renderBrowse(keepScroll = false)
            }
        }
        if (lists.chapters.isNotEmpty()) header.addView(tab(texts.chapters, BrowseTab.CHAPTERS))
        if (lists.upNext.isNotEmpty()) header.addView(tab(texts.upNext, BrowseTab.UP_NEXT))
        header.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
        header.addView(
            Icon(context, BrowseIcons.close).apply {
                iconDp = 20f * scale
                contentDescription = texts.closeBrowse
                isClickable = true
                setOnClickListener { closeBrowse() }
                lp(px(40f), px(40f))
            },
        )
        sheet.addView(header, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        sheet.addView(View(context).apply { setBackgroundColor(0x1FFFFFFF) }, LinearLayout.LayoutParams(MATCH_PARENT, dpf(1f).roundToInt()))

        val list = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(8f), px(8f), px(8f), px(16f))
        }
        if (browseTab == BrowseTab.CHAPTERS) fillChapters(list, lists.chapters) else fillUpNext(list, lists)
        val scroll = ScrollView(context).apply {
            isVerticalScrollBarEnabled = false
            overScrollMode = OVER_SCROLL_NEVER
            addView(list, LayoutParams(MATCH_PARENT, WRAP_CONTENT))
        }
        sheet.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
        browseLayer.addView(sheet, LayoutParams(browseWidthPx(), MATCH_PARENT, Gravity.END))
        browseSheet = sheet
        browseScroll = scroll
        scroll.post {
            if (keep > 0) {
                scroll.scrollY = keep
            } else if (browseTab == BrowseTab.CHAPTERS) {
                // Open where the playhead is.
                chapterRows.getOrNull(currentChapter)?.let { scroll.scrollY = max(it.row.top - px(48f), 0) }
            }
        }
    }

    private fun rowBackground(selected: Boolean) = GradientDrawable().apply {
        setColor(if (selected) 0x26FFFFFF else Color.TRANSPARENT)
        cornerRadius = dpf(10f * scale)
    }

    private fun chapterIndex(chapters: List<BrowseChapter>, seconds: Double) =
        chapters.indexOfFirst { seconds >= it.start && seconds < it.end }

    private fun fillChapters(into: LinearLayout, chapters: List<BrowseChapter>) {
        fun px(dp: Float) = dpf(dp * scale).roundToInt()
        val guide = max(chapters.maxOfOrNull { it.end } ?: 0.0, player.duration.takeIf { it != C.TIME_UNSET }?.div(1000.0) ?: 0.0)
        currentChapter = chapterIndex(chapters, player.currentPosition / 1000.0)
        chapterRows = chapters.mapIndexed { index, chapter ->
            val now = index == currentChapter
            val marker = Icon(context, V10Icons.play).apply {
                iconDp = 14f * scale
                visibility = if (now) VISIBLE else INVISIBLE
            }
            val title = TextView(context).apply {
                text = chapter.title
                setTextSize(TypedValue.COMPLEX_UNIT_DIP, 15f * scale)
                setTextColor(Color.WHITE)
                typeface = if (now) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
                maxLines = 2
            }
            val time = formatTime(chapter.start, guide)
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = px(48f)
                setPadding(px(8f), px(10f), px(12f), px(10f))
                background = rowBackground(now)
                addView(marker, LinearLayout.LayoutParams(px(18f), px(18f)))
                addView(title, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = px(6f) })
                addView(
                    TextView(context).apply {
                        text = time
                        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f * scale)
                        setTextColor(0x99FFFFFF.toInt())
                        fontFeatureSettings = "tnum"
                    },
                    LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = px(12f) },
                )
                contentDescription = "${chapter.title}, $time"
                isSelected = now
                isClickable = true
                setOnClickListener {
                    player.seekTo((chapter.start * 1000).roundToLong())
                    closeBrowse()
                }
            }
            into.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = px(2f) })
            ChapterRow(row, title, marker)
        }
    }

    /** Follows the playhead from chapter to chapter while the panel is open. */
    private fun markCurrentChapter() {
        val chapters = browse?.chapters ?: return
        val index = chapterIndex(chapters, player.currentPosition / 1000.0)
        if (index == currentChapter) return
        currentChapter = index
        chapterRows.forEachIndexed { i, row ->
            val now = i == index
            row.row.background = rowBackground(now)
            row.row.isSelected = now
            row.title.typeface = if (now) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            row.marker.visibility = if (now) VISIBLE else INVISIBLE
        }
    }

    private fun fillUpNext(into: LinearLayout, lists: Browse) {
        fun px(dp: Float) = dpf(dp * scale).roundToInt()
        lists.upNext.forEachIndexed { index, item ->
            // A section's name shows once, over the first item of each run that carries it.
            if (item.section != null && item.section != lists.upNext.getOrNull(index - 1)?.section) {
                into.addView(
                    TextView(context).apply {
                        text = item.section.uppercase()
                        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 11f * scale)
                        typeface = Typeface.DEFAULT_BOLD
                        letterSpacing = 0.06f
                        setTextColor(0x99FFFFFF.toInt())
                        setPadding(px(8f), if (index == 0) px(4f) else px(14f), px(8f), px(6f))
                    },
                    LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT),
                )
            }
            val picture = ImageView(context).apply {
                scaleType = ImageView.ScaleType.CENTER_CROP
                background = GradientDrawable().apply { setColor(0xFF151518.toInt()) }
                clipToOutline = true
                outlineProvider = object : ViewOutlineProvider() {
                    override fun getOutline(view: View, outline: android.graphics.Outline) =
                        outline.setRoundRect(0, 0, view.width, view.height, dpf(8f * scale))
                }
                importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            loadImage(picture, item.imageUrl, item.fallbackImageUrl)
            val words = LinearLayout(context).apply {
                orientation = LinearLayout.VERTICAL
                addView(
                    TextView(context).apply {
                        text = item.title
                        setTextSize(TypedValue.COMPLEX_UNIT_DIP, 14f * scale)
                        typeface = Typeface.DEFAULT_BOLD
                        setTextColor(Color.WHITE)
                        maxLines = 2
                    },
                )
                item.subtitle?.takeIf { it.isNotEmpty() }?.let { subtitle ->
                    addView(
                        TextView(context).apply {
                            text = subtitle
                            setTextSize(TypedValue.COMPLEX_UNIT_DIP, 12f * scale)
                            setTextColor(0x99FFFFFF.toInt())
                            maxLines = 2
                        },
                    )
                }
            }
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(px(8f), px(8f), px(8f), px(8f))
                background = rowBackground(false)
                addView(picture, LinearLayout.LayoutParams(px(UP_NEXT_PICTURE_DP), px(UP_NEXT_PICTURE_DP * 9f / 16f)))
                addView(words, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = px(12f) })
                contentDescription = listOfNotNull(item.title, item.subtitle?.takeIf { it.isNotEmpty() }).joinToString(", ")
                isClickable = true
                setOnClickListener {
                    onBrowseSelect?.invoke(item.id)
                    closeBrowse()
                }
            }
            into.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = px(2f) })
        }
    }

    /** Loads [url] into [into]; when it does not load, or there is none, the [fallback] takes its place. */
    private fun loadImage(into: ImageView, url: String?, fallback: String? = null) {
        val loader = images ?: return
        val first = url?.takeIf { it.isNotEmpty() }
        val second = fallback?.takeIf { it.isNotEmpty() }
        val address = first ?: second ?: return
        val future = runCatching { loader.loadBitmap(Uri.parse(address)) }.getOrNull() ?: return
        loadingImages += future
        Futures.addCallback(
            future,
            object : FutureCallback<Bitmap> {
                override fun onSuccess(result: Bitmap?) {
                    if (result != null && !future.isCancelled && into.isAttachedToWindow) into.setImageBitmap(result)
                }

                // A tile without its picture still names the video.
                override fun onFailure(t: Throwable) {
                    if (first != null && second != null && !future.isCancelled && into.isAttachedToWindow) loadImage(into, null, second)
                }
            },
            ContextCompat.getMainExecutor(context),
        )
    }

    private fun cancelImages() {
        loadingImages.forEach { it.cancel(true) }
        loadingImages.clear()
    }

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
        listOf(muteButton, qualityButton, audioButton, rateButton, subtitlesButton, browseButton, castButton, pipButton, exitButton).forEach {
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
        chapterNow.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 13f * s)
        chapterNow.layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { bottomMargin = px(2f) }
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
        inset = Insets.of(left, top, right, bottom)
        browseSheet?.setPadding(0, top, right, bottom)
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
        private const val BROWSE_SHEET = 0xF2121216.toInt()
        private const val BROWSE_FRACTION = 0.4f
        private const val BROWSE_MIN_DP = 320f
        private const val UP_NEXT_PICTURE_DP = 128f
        private const val NEXT_UP_MS = 250L
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

    /** Where the bar is cut, as fractions of its length (a chapter starts there). */
    var cuts: List<Float> = emptyList()
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }
    var dragging = false
        private set
    var dragAt = 0.0
        private set
    var pointerX = 0f
        private set

    /** The roster is under the timeline: the track is as thick as when held, and stays so while the roster is up. */
    var onRoster = false
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
            onRoster -> 16f
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
        // The gaps go through the track, its buffer and its fill alike, so no gap colour has to match the picture.
        canvas.save()
        val half = ChapterCuts.halfGapDp(cuts.size + 1) * density * scale
        @Suppress("DEPRECATION")
        for (cut in cuts) canvas.clipRect(width * cut - half, 0f, width * cut + half, height.toFloat(), Region.Op.DIFFERENCE)
        bar(1.0, 0x42FFFFFF)
        bar(buffered, 0x66FFFFFF)
        bar(if (dragging) dragAt else played, Color.WHITE)
        canvas.restore()
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

    /** The slow scrub: a finger on the strip slides it under the marker. The time it reaches, and then the lift. */
    var onSlide: ((Double) -> Unit)? = null
    var onSlideEnd: ((Boolean) -> Unit)? = null
    private var downX = 0f
    private var downTime = 0.0

    private fun secondsPerPx(): Double {
        val sample = frames?.sample() ?: return 0.0
        val tileWidth = max(24f * resources.displayMetrics.density, tileHeight * sample.w / sample.h)
        return Roster.step(duration) / tileWidth
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downTime = time
                parent.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> onSlide?.invoke((downTime - (event.x - downX) * secondsPerPx()).coerceIn(0.0, duration))
            MotionEvent.ACTION_UP -> onSlideEnd?.invoke(true)
            MotionEvent.ACTION_CANCEL -> onSlideEnd?.invoke(false)
        }
        return true
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
