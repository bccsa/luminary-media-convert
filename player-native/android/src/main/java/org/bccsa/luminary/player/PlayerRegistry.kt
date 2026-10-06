package org.bccsa.luminary.player

import kotlinx.serialization.json.JsonElement
import okhttp3.OkHttpClient
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Every player, and the one entry point for a call. Main thread only.
 *
 * Checks run in one order on every platform, and the first failure is the rejection: the
 * capability (`unsupported`), the arguments (`invalid-argument`), the player (`unknown-player`),
 * then the generation (`stale-generation`).
 */
class PlayerRegistry(
    private val capabilities: BridgeCapabilities,
    private val clock: Clock,
    private val upstream: HttpUpstream?,
    private val engineFactory: EngineFactory,
    /** How live playlists are read; the router's own OkHttp read when null. */
    private val liveFetch: LiveFetch? = null,
    /** How a warm request is sent. */
    private val warmFetch: WarmFetch = OkHttpWarmFetch(OkHttpClient()),
    private val emit: (name: String, payload: JsonObject) -> Unit,
) {
    private val players = LinkedHashMap<String, PlayerHost>()
    private val destroyed = HashSet<String>()
    private var created = 0

    /** Resolves with the call's JSON answer, or throws [BridgeRejection]. */
    fun call(method: String, args: JsonObject): JsonElement {
        val needs = BridgeCall.capabilityOf(method)
        if (needs != null && !needs(capabilities)) {
            throw BridgeRejection(BridgeErrorCode.UNSUPPORTED, "$method is not supported on this device")
        }
        return handle(BridgeCall.decode(method, args))
    }

    private fun handle(call: BridgeCall): JsonElement {
        when (call) {
            BridgeCall.GetInfo -> return buildJsonObject {
                put("protocolVersion", PROTOCOL_VERSION)
                put("platform", "android")
                put("capabilities", capabilities.toJson())
            }
            BridgeCall.Reset -> players.keys.toList().forEach(::destroy)
            is BridgeCall.Create -> return create(call.options)
            is BridgeCall.Destroy -> if (call.playerId !in destroyed) {
                player(call.playerId)
                destroy(call.playerId)
            }
            else -> return handlePlayerCall(call, player(checkNotNull(call.playerId)))
        }
        return EMPTY
    }

    private fun handlePlayerCall(call: BridgeCall, player: PlayerHost): JsonElement {
        val generation = when (call) {
            is BridgeCall.Load -> call.args.generation
            is BridgeCall.PutAssets -> call.generation
            is BridgeCall.PutLive -> call.generation
            else -> null
        }
        if (generation != null && generation < player.generation) {
            throw BridgeRejection(
                BridgeErrorCode.STALE_GENERATION,
                "generation $generation is older than ${player.generation}",
            )
        }

        val engine = player.engine
        when (call) {
            is BridgeCall.Load -> player.load(call.args)
            is BridgeCall.PutAssets -> player.putAssets(call.generation, call.assets)
            is BridgeCall.ReleaseAssets -> player.releaseAssets(call.generation)
            is BridgeCall.Reattach -> player.reattach(call.loadId)
            is BridgeCall.Play -> engine.play()
            is BridgeCall.Pause -> engine.pause()
            is BridgeCall.Seek -> engine.seek(call.position, call.exact)
            is BridgeCall.SetRate -> engine.setRate(call.rate)
            is BridgeCall.SetVariant -> engine.setVariant(call.id)
            is BridgeCall.SetAudioTrack -> engine.setAudioTrack(call.id)
            is BridgeCall.SetInlineFrame -> player.setInlineFrame(call.frame)
            is BridgeCall.SetMuted -> engine.setMuted(call.muted)
            is BridgeCall.SetSubtitleTrack -> engine.setSubtitleTrack(call.label)
            is BridgeCall.StartPictureInPicture -> engine.startPictureInPicture()
            is BridgeCall.ShowAirPlayPicker -> engine.showAirPlayPicker()
            is BridgeCall.EnterFullscreen -> engine.enterFullscreen(call.texts)
            is BridgeCall.ExitFullscreen -> player.exitFullscreen()
            is BridgeCall.Resumed -> return player.resumed().toJson()
            is BridgeCall.PutLive -> player.putLive(call.generation, call.uri, call.spec)
            is BridgeCall.WarmChunks ->
                player.warmChunks(call.loadId, call.schedules, call.leadSeconds, call.warmBytes)
            BridgeCall.GetInfo, BridgeCall.Reset, is BridgeCall.Create, is BridgeCall.Destroy ->
                error("handled by the registry")
        }
        return EMPTY
    }

    private fun create(options: CreateOptions): JsonElement {
        if (options.protocolVersion != PROTOCOL_VERSION.toDouble()) {
            throw BridgeRejection(
                BridgeErrorCode.PROTOCOL_MISMATCH,
                "protocol ${options.protocolVersion}; this side speaks $PROTOCOL_VERSION",
            )
        }
        // A second create destroys the oldest player, silently.
        while (players.size >= capabilities.maxPlayers) destroy(players.keys.first())
        val playerId = "player-${++created}"
        val host = PlayerHost(
            playerId, clock, capabilities.variantSwitching, upstream, options, engineFactory, liveFetch, warmFetch, emit,
        )
        players[playerId] = host
        return buildJsonObject { put("playerId", playerId) }
    }

    private fun player(playerId: String): PlayerHost =
        players[playerId] ?: throw BridgeRejection(BridgeErrorCode.UNKNOWN_PLAYER, "No player $playerId")

    private fun destroy(playerId: String) {
        players.remove(playerId)?.destroy()
        destroyed += playerId
    }

    private companion object {
        val EMPTY = JsonObject(emptyMap())
    }
}
