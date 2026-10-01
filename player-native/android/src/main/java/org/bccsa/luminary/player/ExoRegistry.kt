package org.bccsa.luminary.player

import android.app.Activity
import android.content.Context
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import org.bccsa.luminary.player.engine.ExoEngine
import org.bccsa.luminary.player.engine.FullscreenPresenter

/** What this platform reports from `getInfo`. */
val ANDROID_CAPABILITIES = BridgeCapabilities(variantSwitching = true, backgroundAudio = true)

/** One per app, shared by every player's `UriRouter`. */
private val sharedHttpClient: OkHttpClient by lazy { OkHttpClient() }

/**
 * The [PlayerRegistry] the plugin runs: ExoPlayer engines, main-looper timers, the shared HTTP
 * client. Public so a host without Capacitor (the spike) runs exactly the same wiring.
 */
fun exoPlayerRegistry(
    context: Context,
    activity: () -> Activity?,
    emit: (name: String, payload: JsonObject) -> Unit,
): PlayerRegistry {
    val engines = EngineFactory { router, clock, options ->
        ExoEngine(context, router, clock, options, FullscreenPresenter(activity))
    }
    return PlayerRegistry(ANDROID_CAPABILITIES, MainLooperClock(), HttpUpstream(sharedHttpClient), engines, emit)
}
