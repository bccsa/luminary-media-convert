package org.bccsa.luminary.player.engine

import android.app.Activity
import android.app.PictureInPictureParams
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Rational
import androidx.core.util.Consumer
import androidx.core.app.OnPictureInPictureModeChangedProvider
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.LifecycleOwner
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
    private var onLeave: (() -> Unit)? = null
    private var onPresentation: ((String) -> Unit)? = null
    private var player: Player? = null
    private val main = Handler(Looper.getMainLooper())
    private var settle: Runnable? = null

    /** The system's word on the picture's small window; the activity is the one that is in it. */
    private val pipListener = Consumer<PictureInPictureModeChangedInfo> { info ->
        val controls = controls ?: return@Consumer
        stopWatching()
        if (info.isInPictureInPictureMode) {
            controls.setPictureInPicture(true)
            onPresentation?.invoke("pip")
            return@Consumer
        }
        decideAfterSmallWindow(controls)
    }

    private var watching: LifecycleEventObserver? = null

    /**
     * Leaving the small window is either the viewer expanding it (the activity comes back to the
     * front: full-screen again) or closing it (the activity goes to the background: that is
     * leaving). The activity's lifecycle says which once it settles: an expanded one ends up
     * resumed (some devices stop and start it on the way there, so a stop alone says nothing), a
     * closed one is left stopped.
     */
    private fun decideAfterSmallWindow(controls: SkinControls) {
        val owner = host as? LifecycleOwner
        fun expanded() {
            controls.setPictureInPicture(false)
            onPresentation?.invoke("fullscreen")
        }
        if (owner == null) return expanded()
        val state = owner.lifecycle.currentState
        if (state.isAtLeast(Lifecycle.State.RESUMED)) return expanded()
        // Paused, as an activity in the small window is, or even stopped for the moment (some
        // devices stop it while expanding): wait for it to come back or stay away.
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) {
                stopWatching()
                expanded()
            }
        }
        watching = observer
        owner.lifecycle.addObserver(observer)
        // No resume in time: an activity that is still on screen was expanded, one that is stopped was closed.
        val fallback = Runnable {
            stopWatching()
            if (owner.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) expanded() else onLeave?.invoke()
        }
        settle = fallback
        main.postDelayed(fallback, PIP_SETTLE_MS)
    }

    private fun stopWatching() {
        settle?.let(main::removeCallbacks)
        settle = null
        watching?.let { (host as? LifecycleOwner)?.lifecycle?.removeObserver(it) }
        watching = null
    }

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
        /** `pip` when the picture has moved to its own small window, `fullscreen` when it is back. */
        onPresentation: (String) -> Unit = {},
        /** The scrub frames the controls draw under a held timeline; none when null. */
        thumbnails: org.bccsa.luminary.player.Thumbnails? = null,
    ): Boolean {
        if (view != null) return false
        val activity = activity() ?: return false
        val surface = PlayerView(activity).apply {
            setBackgroundColor(Color.BLACK)
            // The skin draws its own controls, and none of Media3's, spinner included.
            useController = false
            setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER)
            // A recovery that rebuilds the source keeps the last frame up, not a black shutter, until the new picture shows.
            setKeepContentOnPlayerReset(true)
            this.player = player
        }
        val controls = SkinControls(
            activity, player, skin, texts,
            onPictureInPicture = if (pictureInPictureAvailable(activity)) ({ startPictureInPicture() }) else null,
            thumbnails = thumbnails,
            onLeave = onLeave,
        )
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
        this.onLeave = onLeave
        this.onPresentation = onPresentation
        this.player = player
        (activity as? OnPictureInPictureModeChangedProvider)?.addOnPictureInPictureModeChangedListener(pipListener)
        this.view = view
        this.host = activity
        this.controls = controls
        this.surface = surface
        return true
    }

    /**
     * Moves the picture to its own small window, which shows this view's picture alone. False when
     * nothing is presented or the system will not.
     */
    fun startPictureInPicture(): Boolean {
        val activity = host ?: return false
        val view = view ?: return false
        if (!pictureInPictureAvailable(activity) || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val size = player?.videoSize
        val ratio = if (size != null && size.width > 0 && size.height > 0) {
            Rational(size.width, size.height)
        } else {
            Rational(16, 9)
        }
        // The system refuses what is wider than 2.39:1 or taller than 1:2.39.
        val clamped = if (ratio.toFloat() > MAX_RATIO) Rational(239, 100) else if (ratio.toFloat() < 1 / MAX_RATIO) Rational(100, 239) else ratio
        return try {
            activity.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(clamped).build())
        } catch (refused: IllegalStateException) {
            false
        } catch (refused: IllegalArgumentException) {
            false
        }
    }

    /** False when nothing was presented. */
    fun dismiss(): Boolean {
        val view = view ?: return false
        val activity = host
        stopWatching()
        (activity as? OnPictureInPictureModeChangedProvider)?.removeOnPictureInPictureModeChangedListener(pipListener)
        // Taking the view down while it is in the small window ends it.
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
        this.onLeave = null
        this.onPresentation = null
        this.player = null
        return true
    }

    /** The controls currently on screen, for tests. */
    internal fun skinControls(): SkinControls? = controls

    companion object {
        private const val PIP_SETTLE_MS = 1500L
        private const val MAX_RATIO = 2.39f

        /** `ActivityInfo.FLAG_SUPPORTS_PICTURE_IN_PICTURE`: set by `android:supportsPictureInPicture`, and not in the public API. */
        private const val FLAG_SUPPORTS_PICTURE_IN_PICTURE = 0x400000

        /** The system has picture in picture, and this activity has said it may be put in one. */
        fun pictureInPictureAvailable(activity: Activity): Boolean {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
            if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
            return try {
                val info = activity.packageManager.getActivityInfo(activity.componentName, 0)
                info.flags and FLAG_SUPPORTS_PICTURE_IN_PICTURE != 0
            } catch (missing: PackageManager.NameNotFoundException) {
                false
            }
        }
    }
}
