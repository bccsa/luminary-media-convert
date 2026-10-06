package org.bccsa.luminary.player.engine

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.annotation.OptIn
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView

/**
 * A full-window picture over the WebView: system bars hidden, orientation following the sensor,
 * `player-web`'s skin on top of it ([SkinControls]), and the back gesture, the exit button and a
 * double tap all leaving it. The view only borrows the player; dismissing hands it back.
 *
 * Audio-only has no view: the caller does not present one, and dismisses one already up when the
 * item turns out to have no video.
 */
@OptIn(UnstableApi::class)
class FullscreenPresenter(private val activity: () -> Activity?) {
    private var view: FrameLayout? = null
    private var host: Activity? = null
    private var backCallback: OnBackPressedCallback? = null
    private var savedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    private var controls: SkinControls? = null
    private var surface: PlayerView? = null

    val isPresented: Boolean get() = view != null

    /**
     * False when already presented, or there is no activity to present in. [onLeave] is the
     * viewer asking to leave; the caller decides what that means and dismisses.
     */
    fun present(
        player: Player,
        onLeave: () -> Unit,
        skin: SkinOptions = SkinOptions(),
        texts: FullscreenTexts = FullscreenTexts(),
    ): Boolean {
        if (view != null) return false
        val activity = activity() ?: return false
        val surface = PlayerView(activity).apply {
            setBackgroundColor(Color.BLACK)
            // The skin draws its own controls, and none of Media3's, spinner included.
            useController = false
            setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
            this.player = player
        }
        val controls = SkinControls(activity, player, skin, texts, onLeave)
        val view = FrameLayout(activity).apply {
            setBackgroundColor(Color.BLACK)
            keepScreenOn = true
            addView(surface, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            addView(controls, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        (activity.window.decorView as ViewGroup).addView(
            view,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        savedOrientation = activity.requestedOrientation
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        WindowCompat.getInsetsController(activity.window, view).apply {
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            hide(WindowInsetsCompat.Type.systemBars())
        }
        if (activity is ComponentActivity) {
            backCallback = object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() = onLeave()
            }.also { activity.onBackPressedDispatcher.addCallback(it) }
        }
        this.view = view
        this.host = activity
        this.controls = controls
        this.surface = surface
        return true
    }

    /** False when nothing was presented. */
    fun dismiss(): Boolean {
        val view = view ?: return false
        val activity = host
        backCallback?.remove()
        backCallback = null
        surface?.player = null
        (view.parent as? ViewGroup)?.removeView(view)
        if (activity != null) {
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = savedOrientation
        }
        this.view = null
        this.host = null
        this.controls = null
        this.surface = null
        return true
    }

    /** The controls currently on screen, for tests. */
    internal fun skinControls(): SkinControls? = controls
}
