package org.bccsa.luminary.player.engine

import android.app.Activity
import android.content.ComponentCallbacks
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.OrientationEventListener
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.view.Gravity
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import android.util.TypedValue
import org.bccsa.luminary.player.InlineFrame

/**
 * The picture shown inside the page: a [PlayerView] *behind* the web view, in the frame JavaScript
 * names, which the page leaves see-through (it clears its own backgrounds there). The page keeps
 * drawing whatever it likes over the picture (the full-screen button, panels), which a view laid
 * over the web view could not allow.
 *
 * While the view shows, the web view is made transparent; when it hides, the web view is as it was.
 * The picture is the same player the full-screen view borrows, so it lets go of it ([setSuspended])
 * while full-screen or picture in picture holds the picture.
 */
@OptIn(UnstableApi::class)
class InlinePresenter(
    /** Asked for the Capacitor bridge's web view each time. */
    private val webView: () -> View?,
    private val activity: () -> Activity? = { null },
) {
    private var videoView: PlayerView? = null
    /** The subtitles, over the page: in the room the page leaves under the picture, or over the picture's foot. */
    private var subtitleView: View? = null
    private var expandBadge: ExpandBadge? = null
    private var frame: InlineFrame? = null
    private var suspended = false
    private var player: Player? = null
    private var restore: Drawable? = null
    private var transparent = false
    private var tracking: View? = null
    private var keepLastFrame = true

    /** Called when the view's surface has been created afresh: whatever was drawn in the last one is gone. */
    var onSurfaceCreated: (() -> Unit)? = null

    /** Called when the phone is turned to landscape while the page shows the picture and nothing else holds it. */
    var onRotatedToLandscape: (() -> Unit)? = null

    private val relayout = View.OnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> layout() }

    private val configuration = object : ComponentCallbacks {
        override fun onConfigurationChanged(newConfig: Configuration) {
            if (frame != null && !suspended && newConfig.orientation == Configuration.ORIENTATION_LANDSCAPE) {
                onRotatedToLandscape?.invoke()
            }
        }

        @Deprecated("Part of the interface")
        override fun onLowMemory() {}
    }
    private var observing: Activity? = null

    /**
     * A host whose pages stay upright never changes configuration on a turn, so the turn is read from the
     * sensor as well, while the viewer lets the phone rotate. The phone has to stay on its side for a moment:
     * a glance or a wobble on the way does not count.
     */
    private var sensor: OrientationEventListener? = null
    private var sideways = false
    private val main = Handler(Looper.getMainLooper())
    private val settled = Runnable {
        val host = activity() ?: return@Runnable
        // A picture that is only the small one in the minimised bar is not what the viewer turned the phone to watch.
        if (sideways && frame != null && frame?.front != true && !suspended &&
            host.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        ) {
            onRotatedToLandscape?.invoke()
        }
    }

    private fun autoRotateOn(host: Activity): Boolean =
        Settings.System.getInt(host.contentResolver, Settings.System.ACCELEROMETER_ROTATION, 0) == 1

    private fun watchSensor(host: Activity) {
        if (sensor != null) return
        val listener = object : OrientationEventListener(host) {
            override fun onOrientationChanged(degrees: Int) {
                val now = phonePoseOf(degrees)?.let { it == PhonePose.SIDEWAYS } ?: return
                if (now == sideways) return
                sideways = now
                main.removeCallbacks(settled)
                if (now && autoRotateOn(host)) main.postDelayed(settled, SIDEWAYS_SETTLE_MS)
            }
        }
        if (listener.canDetectOrientation()) {
            listener.enable()
            sensor = listener
        }
    }

    /** The view showing the picture, for tests. */
    internal val view: PlayerView? get() = videoView

    fun setFrame(frame: InlineFrame?, player: Player) {
        this.frame = frame
        this.player = player
        val web = webView()
        val container = web?.parent as? ViewGroup
        if (frame == null || web == null || container == null) {
            tearDown()
            return
        }
        val view = videoView ?: makeVideoView(container, web)
        if (tracking !== web) {
            tracking?.removeOnLayoutChangeListener(relayout)
            web.addOnLayoutChangeListener(relayout)
            tracking = web
        }
        observeRotation()
        stack(web, view, frame.front)
        layout()
        makeTransparent(web)
        view.player = if (suspended) null else player
    }

    /**
     * Whether the last frame stays up while a source loads. A reload of the same video keeps it, so a
     * recovery shows no black shutter; another video starts from black, not from the previous picture.
     */
    fun keepLastFrame(keep: Boolean) {
        keepLastFrame = keep
        videoView?.setKeepContentOnPlayerReset(keep)
    }

    /** Full-screen or picture in picture holds the picture: the inline view has none. */
    fun setSuspended(suspended: Boolean) {
        this.suspended = suspended
        if (suspended) expandBadge?.visibility = View.GONE
        val view = videoView ?: return
        if (suspended) {
            view.player = null
        } else {
            layout()
            view.player = player
        }
    }

    fun destroy() {
        frame = null
        tearDown()
    }

    /** The page's coordinates are the web view's: its own origin, then the frame, in CSS pixels. */
    private fun layout() {
        val frame = frame ?: return
        val web = webView() ?: return
        val view = videoView ?: return
        val density = web.resources.displayMetrics.density
        val width = (frame.width * density).toInt().coerceAtLeast(1)
        val height = (frame.height * density).toInt().coerceAtLeast(1)
        val params = view.layoutParams
        if (params.width != width || params.height != height) {
            params.width = width
            params.height = height
            view.layoutParams = params
        }
        view.x = web.x + (frame.x * density).toFloat()
        view.y = web.y + (frame.y * density).toFloat()
        roundCorners(view, if (frame.front) (frame.radius * density).toFloat() else 0f)
        layoutSubtitles(frame, web, density)
        layoutBadge(frame, web, view, density)
    }

    /** A picture in front fits the page's rounded card; behind the page, the page's own corners shape it. */
    private fun roundCorners(view: PlayerView, radius: Float) {
        if (radius <= 0f) {
            view.clipToOutline = false
            view.videoSurfaceView?.clipToOutline = false
            return
        }
        val outline = object : android.view.ViewOutlineProvider() {
            override fun getOutline(v: View, out: android.graphics.Outline) = out.setRoundRect(0, 0, v.width, v.height, radius)
        }
        view.outlineProvider = outline
        view.clipToOutline = true
        // The picture's own surface, which the view's clip does not reach on its own.
        view.videoSurfaceView?.let {
            it.outlineProvider = outline
            it.clipToOutline = true
        }
    }

    /** Over a picture in front the page's own chevron is hidden, so the same badge is drawn here, where it stands. */
    private fun layoutBadge(frame: InlineFrame, web: View, view: PlayerView, density: Float) {
        if (!frame.badge || !frame.front || suspended) {
            expandBadge?.visibility = View.GONE
            return
        }
        val container = view.parent as? ViewGroup ?: return
        val badge = expandBadge ?: ExpandBadge(web.context).also {
            container.addView(it, ViewGroup.LayoutParams(1, 1))
            expandBadge = it
        }
        val side = (ExpandBadge.SIZE_DP * density).toInt()
        val params = badge.layoutParams
        if (params.width != side || params.height != side) {
            params.width = side
            params.height = side
            badge.layoutParams = params
        }
        badge.visibility = View.VISIBLE
        badge.x = view.x + ExpandBadge.INSET_X_DP * density
        badge.y = view.y + ExpandBadge.INSET_Y_DP * density
        badge.z = view.z + 1f
    }

    /** Under the picture when the page left room there, else over its foot; none over a small picture in front or a covered place. */
    private fun layoutSubtitles(frame: InlineFrame, web: View, density: Float) {
        val subtitles = subtitleView ?: return
        // Not over a small picture in front, nor over what the page puts across the picture's place.
        if (frame.front || frame.captionsHidden) {
            subtitles.visibility = View.GONE
            return
        }
        subtitles.visibility = View.VISIBLE
        val room = (frame.captionHeight * density).toInt()
        // A band of its own is read at a size a phone reads; over the picture the size follows the picture's.
        (subtitles as? SubtitleView)?.let { text ->
            if (room > 0) {
                text.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
                // On the page's own colour the words need no box of their own, only a shadow to keep them readable.
                text.setStyle(CaptionStyleCompat(Color.WHITE, Color.TRANSPARENT, Color.TRANSPARENT, CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, Color.BLACK, PlayerFont.semibold(text.context)))
            } else {
                text.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION)
                text.setStyle(PlayerFont.captions(text.context, CaptionStyleCompat.DEFAULT))
            }
        }
        val height = if (room > 0) room else (frame.height * density).toInt().coerceAtLeast(1)
        val width = (frame.width * density).toInt().coerceAtLeast(1)
        val params = subtitles.layoutParams
        if (params.width != width || params.height != height) {
            params.width = width
            params.height = height
            subtitles.layoutParams = params
        }
        subtitles.x = web.x + (frame.x * density).toFloat()
        subtitles.y = web.y + (frame.y * density).toFloat() + (if (room > 0) (frame.height * density).toFloat() else 0f)
        subtitles.bringToFront()
    }

    /**
     * Behind the web view, where the page cuts a hole for it, or over it for a small picture. Raised, not
     * moved in the child order: taking a SurfaceView out of the window destroys its surface, and the new one
     * stays black until a frame is drawn into it.
     */
    private fun stack(web: View, view: PlayerView, front: Boolean) {
        view.z = if (front) web.z + 1f else web.z
    }

    private fun makeVideoView(container: ViewGroup, web: View): PlayerView {
        val view = PlayerView(web.context).apply {
            useController = false
            setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
            setKeepContentOnPlayerReset(keepLastFrame)
            setBackgroundColor(Color.BLACK)
            isClickable = false
            isFocusable = false
        }
        // The picture sits at the top of the frame: the page leaves a band under it, and the subtitles,
        // drawn at the view's foot, fall in that band instead of over the picture.
        (view.findViewById<View>(androidx.media3.ui.R.id.exo_content_frame)?.layoutParams as? FrameLayout.LayoutParams)
            ?.let { it.gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL }
        // Below the web view in the draw order, so the page draws over the picture.
        container.addView(view, container.indexOfChild(web), ViewGroup.LayoutParams(1, 1))
        view.subtitleView?.let { subtitles ->
            (subtitles.parent as? ViewGroup)?.removeView(subtitles)
            container.addView(subtitles, ViewGroup.LayoutParams(1, 1))
            subtitleView = subtitles
        }
        (view.videoSurfaceView as? SurfaceView)?.holder?.addCallback(object : SurfaceHolder.Callback {
            override fun surfaceCreated(holder: SurfaceHolder) {
                onSurfaceCreated?.invoke()
            }

            override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

            override fun surfaceDestroyed(holder: SurfaceHolder) {}
        })
        videoView = view
        return view
    }

    private fun makeTransparent(web: View) {
        if (!transparent) {
            restore = web.background
            transparent = true
        }
        web.setBackgroundColor(Color.TRANSPARENT)
    }

    private fun observeRotation() {
        val host = activity() ?: return
        watchSensor(host)
        if (observing === host) return
        observing?.unregisterComponentCallbacks(configuration)
        host.registerComponentCallbacks(configuration)
        observing = host
    }

    private fun tearDown() {
        tracking?.removeOnLayoutChangeListener(relayout)
        tracking = null
        observing?.unregisterComponentCallbacks(configuration)
        observing = null
        sensor?.disable()
        sensor = null
        sideways = false
        main.removeCallbacks(settled)
        videoView?.let { view ->
            view.player = null
            (view.parent as? ViewGroup)?.removeView(view)
        }
        subtitleView?.let { (it.parent as? ViewGroup)?.removeView(it) }
        subtitleView = null
        expandBadge?.let { (it.parent as? ViewGroup)?.removeView(it) }
        expandBadge = null
        videoView = null
        if (transparent) {
            webView()?.background = restore
            transparent = false
            restore = null
        }
    }
}

/** How long the phone stays on its side before the picture goes full-screen. */
private const val SIDEWAYS_SETTLE_MS = 250L
