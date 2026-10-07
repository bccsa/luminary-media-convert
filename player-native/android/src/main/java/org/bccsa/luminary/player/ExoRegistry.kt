package org.bccsa.luminary.player

import android.app.Activity
import android.content.Context
import android.view.View
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import org.bccsa.luminary.player.engine.ExoEngine
import org.bccsa.luminary.player.engine.FullscreenPresenter
import org.bccsa.luminary.player.engine.GoogleCastSupport
import org.bccsa.luminary.player.engine.InlinePresenter

/** What this platform reports from `getInfo`. */
val ANDROID_CAPABILITIES = BridgeCapabilities(
    variantSwitching = true,
    live = true,
    chunkWarming = true,
    backgroundAudio = true,
    muting = true,
    subtitleSelection = true,
    inlineVideo = true,
)

/** One per app, shared by every player's `UriRouter`. */
private val sharedHttpClient: OkHttpClient by lazy { OkHttpClient() }

/**
 * The [PlayerRegistry] the plugin runs: ExoPlayer engines, main-looper timers, the shared HTTP
 * client. Public so a host without Capacitor (the spike) runs exactly the same wiring.
 */
fun exoPlayerRegistry(
    context: Context,
    activity: () -> Activity?,
    /** The Capacitor bridge's web view, which the picture shown in the page goes behind. */
    webView: () -> View? = { null },
    emit: (name: String, payload: JsonObject) -> Unit,
): PlayerRegistry {
    // Google Cast needs the host to have opted in and the device to have Play services. `airPlay` is
    // the bridge's name for "send playback to a device near you": on Android that is Cast.
    val casting = GoogleCastSupport.supported(context)
    // The TV's menu is our own receiver's; Google's default receiver has none.
    val castMenu = casting && GoogleCastSupport.receiverAppId(context) != null
    val engines = EngineFactory { router, clock, options ->
        ExoEngine(
            context, router, clock, options, FullscreenPresenter(activity),
            inline = InlinePresenter(webView, activity),
            cast = if (casting) GoogleCastSupport(context, activity) else null,
        )
    }
    // Picture in picture needs the system's support and an activity that has opted in.
    val pictureInPicture = activity()?.let(FullscreenPresenter::pictureInPictureAvailable) ?: false
    return PlayerRegistry(
        ANDROID_CAPABILITIES.copy(pictureInPicture = pictureInPicture, airPlay = casting, castMenu = castMenu), MainLooperClock(), HttpUpstream(sharedHttpClient), engines, OkHttpLiveFetch(sharedHttpClient),
        OkHttpWarmFetch(sharedHttpClient), emit,
    )
}
