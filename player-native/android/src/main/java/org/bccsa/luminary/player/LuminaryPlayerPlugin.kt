package org.bccsa.luminary.player

import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * The bridge's native end: decode and validate, then the main thread, then [PlayerRegistry].
 * Rejects only with a [BridgeErrorCode]. Never logs a call: `load` carries the key.
 */
@CapacitorPlugin(name = "LuminaryPlayer")
class LuminaryPlayerPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())
    private lateinit var registry: PlayerRegistry

    override fun load() {
        registry = exoPlayerRegistry(context, { activity }) { name, payload ->
            notifyListeners(name, JSObject(payload.toString()))
        }
    }

    /** Players outliving their activity would be orphaned audio. */
    override fun handleOnDestroy() {
        main.post { runCatching { registry.call("reset", JsonObject(emptyMap())) } }
        super.handleOnDestroy()
    }

    @PluginMethod fun getInfo(call: PluginCall) = dispatch("getInfo", call)
    @PluginMethod fun reset(call: PluginCall) = dispatch("reset", call)
    @PluginMethod fun create(call: PluginCall) = dispatch("create", call)
    @PluginMethod fun load(call: PluginCall) = dispatch("load", call)
    @PluginMethod fun putAssets(call: PluginCall) = dispatch("putAssets", call)
    @PluginMethod fun putLive(call: PluginCall) = dispatch("putLive", call)
    @PluginMethod fun releaseAssets(call: PluginCall) = dispatch("releaseAssets", call)
    @PluginMethod fun reattach(call: PluginCall) = dispatch("reattach", call)
    @PluginMethod fun play(call: PluginCall) = dispatch("play", call)
    @PluginMethod fun pause(call: PluginCall) = dispatch("pause", call)
    @PluginMethod fun seek(call: PluginCall) = dispatch("seek", call)
    @PluginMethod fun setRate(call: PluginCall) = dispatch("setRate", call)
    @PluginMethod fun setVariant(call: PluginCall) = dispatch("setVariant", call)
    @PluginMethod fun setAudioTrack(call: PluginCall) = dispatch("setAudioTrack", call)
    @PluginMethod fun warmChunks(call: PluginCall) = dispatch("warmChunks", call)
    @PluginMethod fun setInlineFrame(call: PluginCall) = dispatch("setInlineFrame", call)
    @PluginMethod fun setMuted(call: PluginCall) = dispatch("setMuted", call)
    @PluginMethod fun setSubtitleTrack(call: PluginCall) = dispatch("setSubtitleTrack", call)
    @PluginMethod fun startPictureInPicture(call: PluginCall) = dispatch("startPictureInPicture", call)
    @PluginMethod fun enterFullscreen(call: PluginCall) = dispatch("enterFullscreen", call)
    @PluginMethod fun exitFullscreen(call: PluginCall) = dispatch("exitFullscreen", call)
    @PluginMethod fun resumed(call: PluginCall) = dispatch("resumed", call)
    @PluginMethod fun destroy(call: PluginCall) = dispatch("destroy", call)

    /** Capacitor delivers calls in order on one thread; posting keeps that order on the main thread. */
    private fun dispatch(method: String, call: PluginCall) {
        val args = Json.parseToJsonElement(call.data.toString()) as JsonObject
        main.post {
            try {
                call.resolve(JSObject(registry.call(method, args).toString()))
            } catch (rejection: BridgeRejection) {
                call.reject(rejection.message, rejection.code.wire)
            } catch (error: Exception) {
                call.reject(error.message ?: error.javaClass.simpleName, BridgeErrorCode.ENGINE.wire)
            }
        }
    }
}
