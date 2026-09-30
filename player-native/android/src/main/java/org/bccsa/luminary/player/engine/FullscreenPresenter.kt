package org.bccsa.luminary.player.engine

import android.app.Activity
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.view.ViewGroup
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
 * A full-window [PlayerView] over the WebView: system bars hidden, orientation following the
 * sensor, the back gesture leaving it. The view only borrows the player; dismissing hands it back.
 */
@OptIn(UnstableApi::class)
class FullscreenPresenter(private val activity: () -> Activity?) {
    private var view: PlayerView? = null
    private var host: Activity? = null
    private var backCallback: OnBackPressedCallback? = null
    private var savedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED

    val isPresented: Boolean get() = view != null

    /** False when already presented, or there is no activity to present in. */
    fun present(player: Player, onBack: () -> Unit): Boolean {
        if (view != null) return false
        val activity = activity() ?: return false
        val view = PlayerView(activity).apply {
            setBackgroundColor(Color.BLACK)
            keepScreenOn = true
            this.player = player
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
                override fun handleOnBackPressed() = onBack()
            }.also { activity.onBackPressedDispatcher.addCallback(it) }
        }
        this.view = view
        this.host = activity
        return true
    }

    /** False when nothing was presented. */
    fun dismiss(): Boolean {
        val view = view ?: return false
        val activity = host
        backCallback?.remove()
        backCallback = null
        view.player = null
        (view.parent as? ViewGroup)?.removeView(view)
        if (activity != null) {
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .show(WindowInsetsCompat.Type.systemBars())
            activity.requestedOrientation = savedOrientation
        }
        this.view = null
        this.host = null
        return true
    }
}
