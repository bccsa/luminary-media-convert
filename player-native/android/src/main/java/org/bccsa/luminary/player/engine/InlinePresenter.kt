package org.bccsa.luminary.player.engine

import android.app.Activity
import android.content.ComponentCallbacks
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
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
    private var frame: InlineFrame? = null
    private var suspended = false
    private var player: Player? = null
    private var restore: Drawable? = null
    private var transparent = false
    private var tracking: View? = null

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
        layout()
        makeTransparent(web)
        view.player = if (suspended) null else player
    }

    /** Full-screen or picture in picture holds the picture: the inline view has none. */
    fun setSuspended(suspended: Boolean) {
        this.suspended = suspended
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
    }

    private fun makeVideoView(container: ViewGroup, web: View): PlayerView {
        val view = PlayerView(web.context).apply {
            useController = false
            setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
            setBackgroundColor(Color.BLACK)
            isClickable = false
            isFocusable = false
        }
        // Below the web view in the draw order, so the page draws over the picture.
        container.addView(view, container.indexOfChild(web), ViewGroup.LayoutParams(1, 1))
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
        videoView?.let { view ->
            view.player = null
            (view.parent as? ViewGroup)?.removeView(view)
        }
        videoView = null
        if (transparent) {
            webView()?.background = restore
            transparent = false
            restore = null
        }
    }
}
