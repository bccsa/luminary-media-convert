package org.bccsa.luminary.player.engine

import android.app.Activity
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.drawable.Icon
import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Rational
import androidx.core.content.ContextCompat
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
import androidx.media3.common.util.Util
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
    private var wasPortrait = false
    /** Turning back to portrait, then handing the orientation back to what it was. */
    private var restoring: Runnable? = null

    private var texts = FullscreenTexts()
    private var pipReceiver: BroadcastReceiver? = null
    private val pipPlayerListener = object : Player.Listener {
        override fun onIsPlayingChanged(isPlaying: Boolean) = refreshPipActions()
        override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) = refreshPipActions()
    }

    /** The system's word on the picture's small window; the activity is the one that is in it. */
    private val pipListener = Consumer<PictureInPictureModeChangedInfo> { info ->
        val controls = controls ?: return@Consumer
        stopWatching()
        if (info.isInPictureInPictureMode) {
            watchPipPlayback()
            controls.setPictureInPicture(true)
            onPresentation?.invoke("pip")
            return@Consumer
        }
        unwatchPipPlayback()
        decideAfterSmallWindow(controls)
    }

    /**
     * The small window offers one control of the app's own, play / pause. Without it the system
     * crowds in the media session's previous / next as well, which do not fit a window this small.
     */
    private fun pipActions(activity: Activity): List<RemoteAction> {
        val player = player ?: return emptyList()
        val showPlay = Util.shouldShowPlayButton(player)
        val label = if (showPlay) texts.play else texts.pause
        val icon = Icon.createWithResource(activity, if (showPlay) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause)
        val intent = PendingIntent.getBroadcast(
            activity, 0, Intent(PIP_TOGGLE).setPackage(activity.packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return listOf(RemoteAction(icon, label, label, intent))
    }

    private fun refreshPipActions() {
        val activity = host ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !activity.isInPictureInPictureMode) return
        runCatching { activity.setPictureInPictureParams(PictureInPictureParams.Builder().setActions(pipActions(activity)).build()) }
    }

    private fun watchPipPlayback() {
        val activity = host ?: return
        player?.addListener(pipPlayerListener)
        if (pipReceiver == null) {
            val receiver = object : BroadcastReceiver() {
                override fun onReceive(context: Context?, intent: Intent?) {
                    val player = player ?: return
                    if (Util.shouldShowPlayButton(player)) Util.handlePlayButtonAction(player) else Util.handlePauseButtonAction(player)
                }
            }
            ContextCompat.registerReceiver(activity, receiver, IntentFilter(PIP_TOGGLE), ContextCompat.RECEIVER_NOT_EXPORTED)
            pipReceiver = receiver
        }
        refreshPipActions()
    }

    private fun unwatchPipPlayback() {
        player?.removeListener(pipPlayerListener)
        pipReceiver?.let { runCatching { host?.unregisterReceiver(it) } }
        pipReceiver = null
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
        /** Opens the list of Cast devices; no button when null. */
        onCast: (() -> Unit)? = null,
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
            onCast = onCast,
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
        finishRestoring()
        savedOrientation = activity.requestedOrientation
        wasPortrait = activity.resources.configuration.orientation == Configuration.ORIENTATION_PORTRAIT
        // Always landscape (either way up): portrait is the host app's own media experience.
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
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
        this.texts = texts
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
            activity.enterPictureInPictureMode(PictureInPictureParams.Builder().setAspectRatio(clamped).setActions(pipActions(activity)).build())
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
        unwatchPipPlayback()
        (activity as? OnPictureInPictureModeChangedProvider)?.removeOnPictureInPictureModeChangedListener(pipListener)
        // Taking the view down while it is in the small window ends it.
        backCallback?.remove()
        backCallback = null
        surface?.player = null
        (view.parent as? ViewGroup)?.removeView(view)
        if (activity != null) {
            WindowCompat.getInsetsController(activity.window, activity.window.decorView)
                .show(WindowInsetsCompat.Type.systemBars())
            restoreOrientation(activity)
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

    /**
     * Leaving a landscape lock does not turn a phone that was upright back by itself when its sensor gives
     * no signal (flat on a table), so portrait is asked for first, and the old setting handed back after.
     */
    private fun restoreOrientation(activity: Activity) {
        if (!wasPortrait) {
            activity.requestedOrientation = savedOrientation
            return
        }
        activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        val handBack = Runnable {
            restoring = null
            activity.requestedOrientation = savedOrientation
        }
        restoring = handBack
        main.postDelayed(handBack, ORIENTATION_SETTLE_MS)
    }

    private fun finishRestoring() {
        val pending = restoring ?: return
        main.removeCallbacks(pending)
        pending.run()
    }

    /** The controls currently on screen, for tests. */
    internal fun skinControls(): SkinControls? = controls

    companion object {
        private const val PIP_SETTLE_MS = 1500L
        private const val PIP_TOGGLE = "org.bccsa.luminary.player.PIP_TOGGLE"
        private const val MAX_RATIO = 2.39f
        private const val ORIENTATION_SETTLE_MS = 600L

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
