package org.bccsa.luminary.player.engine

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.media3.cast.CastPlayer
import androidx.media3.cast.SessionAvailabilityListener
import androidx.media3.common.Player
import androidx.mediarouter.app.MediaRouteChooserDialog
import androidx.mediarouter.app.MediaRouteControllerDialog
import com.google.android.gms.cast.framework.CastContext
import com.google.android.gms.cast.framework.CastState
import com.google.android.gms.cast.framework.CastStateListener
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import java.util.concurrent.Executor

/**
 * Google Cast, as far as the engine needs it: whether there are devices to send playback to, whether
 * playback is on one, and the system's device list. This is the only place that touches the Cast
 * SDK, behind an interface so everything else runs without Play services.
 */
interface CastSupport {
    interface Listener {
        /** [available]: a receiver is in range. [active]: connected to one. */
        fun routesChanged(available: Boolean, active: Boolean)

        /** Playback can move to the receiver: [player] is the one that drives it. */
        fun sessionAvailable(player: Player)

        /** The session ended, or the receiver went away. */
        fun sessionLost()
    }

    /** Starts watching for receivers; the listener is told as soon as the SDK is ready, and on every change. */
    fun start(listener: Listener)

    /** The chooser when idle, the controller (with the way to disconnect) when connected. Nothing until the SDK is ready. */
    fun showPicker()

    /** Stops watching. */
    fun stop()
}

/**
 * Google Cast through the Cast framework and MediaRouter. The Cast SDK needs Google Play services, so
 * the host has to opt in (`org.bccsa.luminary.player.CAST` = `true` in its manifest) and the device
 * has to have them: [supported] is the one question to ask before building one.
 */
class GoogleCastSupport(private val context: Context, private val activity: () -> Activity?) : CastSupport {
    private val main = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor(main::post)
    private var cast: CastContext? = null
    private var stateListener: CastStateListener? = null
    private var castPlayer: CastPlayer? = null
    private var stopped = false

    override fun start(listener: CastSupport.Listener) {
        stopped = false
        // Asynchronous: Play services can take a moment, and the main thread must not wait for them.
        CastContext.getSharedInstance(context.applicationContext, mainExecutor)
            .addOnFailureListener(mainExecutor) { Log.w(TAG, "Cast is not available: ${it.message}") }
            .addOnSuccessListener(mainExecutor) { castContext ->
                if (stopped) return@addOnSuccessListener
                cast = castContext
                val watcher = CastStateListener { state -> listener.routesChanged(available(state), state == CastState.CONNECTED) }
                stateListener = watcher
                castContext.addCastStateListener(watcher)
                // Listeners are told of changes; the state as it is now is told here.
                watcher.onCastStateChanged(castContext.castState)

                val receiver = CastPlayer(castContext)
                castPlayer = receiver
                receiver.setSessionAvailabilityListener(object : SessionAvailabilityListener {
                    override fun onCastSessionAvailable() = listener.sessionAvailable(receiver)

                    override fun onCastSessionUnavailable() = listener.sessionLost()
                })
                // A session already running when the app starts is one to take over.
                if (receiver.isCastSessionAvailable) listener.sessionAvailable(receiver)
            }
    }

    private fun available(state: Int) = state != CastState.NO_DEVICES_AVAILABLE

    override fun showPicker() {
        val activity = activity() ?: return
        val castContext = cast ?: return
        val selector = castContext.mergedSelector ?: return
        val connected = castContext.castState == CastState.CONNECTED || castContext.castState == CastState.CONNECTING
        if (connected) {
            MediaRouteControllerDialog(activity).show()
        } else {
            MediaRouteChooserDialog(activity).apply { routeSelector = selector }.show()
        }
    }

    override fun stop() {
        stopped = true
        stateListener?.let { cast?.removeCastStateListener(it) }
        stateListener = null
        castPlayer?.setSessionAvailabilityListener(null)
        castPlayer?.release()
        castPlayer = null
        cast = null
    }

    companion object {
        private const val TAG = "LuminaryCast"

        /** The manifest key a host sets to `true` to opt in. */
        const val OPT_IN = "org.bccsa.luminary.player.CAST"

        /** The host opted in, and this device has Google Play services to run the Cast SDK on. */
        fun supported(context: Context): Boolean {
            val flag = try {
                context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA).metaData?.getBoolean(OPT_IN)
            } catch (missing: PackageManager.NameNotFoundException) {
                null
            } == true
            return flag && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context) == ConnectionResult.SUCCESS
        }
    }
}
