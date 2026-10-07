package org.bccsa.luminary.player

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.put

/*
 * The bridge contract, mirrored by hand from `player-native/src/bridge.ts` (the source of truth),
 * and the one place a call's JSON is decoded and validated. The plugin and the conformance harness
 * both enter here, so the scenarios test the path the app runs.
 */

const val PROTOCOL_VERSION = 1
const val ASSET_URI_PREFIX = "luminary://asset/"
const val KEY_URI = "luminary://key"
const val LIVE_URI_PREFIX = "luminary://live/"

/** The only codes native passes to `call.reject(message, code)`. */
enum class BridgeErrorCode(val wire: String) {
    UNSUPPORTED("unsupported"),
    UNKNOWN_PLAYER("unknown-player"),
    STALE_GENERATION("stale-generation"),
    INVALID_ARGUMENT("invalid-argument"),
    PROTOCOL_MISMATCH("protocol-mismatch"),
    ENGINE("engine"),
}

/** A refused call. A refused call changes nothing. */
class BridgeRejection(val code: BridgeErrorCode, message: String) : Exception(message)

data class BridgeCapabilities(
    val variantSwitching: Boolean = false,
    val pictureInPicture: Boolean = false,
    val renderText: Boolean = false,
    val live: Boolean = false,
    val chunkWarming: Boolean = false,
    val backgroundAudio: Boolean = false,
    val inlineVideo: Boolean = false,
    val muting: Boolean = false,
    val subtitleSelection: Boolean = false,
    val airPlay: Boolean = false,
    val castMenu: Boolean = false,
    val maxPlayers: Int = 1,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("variantSwitching", variantSwitching)
        put("pictureInPicture", pictureInPicture)
        put("renderText", renderText)
        put("live", live)
        put("chunkWarming", chunkWarming)
        put("backgroundAudio", backgroundAudio)
        put("inlineVideo", inlineVideo)
        put("muting", muting)
        put("subtitleSelection", subtitleSelection)
        put("airPlay", airPlay)
        put("castMenu", castMenu)
        put("maxPlayers", maxPlayers)
    }

    companion object {
        fun fromJson(json: JsonObject): BridgeCapabilities {
            fun flag(key: String) = (json[key] as? JsonPrimitive)?.booleanOrNull ?: false
            return BridgeCapabilities(
                variantSwitching = flag("variantSwitching"),
                pictureInPicture = flag("pictureInPicture"),
                renderText = flag("renderText"),
                live = flag("live"),
                chunkWarming = flag("chunkWarming"),
                backgroundAudio = flag("backgroundAudio"),
                inlineVideo = flag("inlineVideo"),
                muting = flag("muting"),
                subtitleSelection = flag("subtitleSelection"),
                airPlay = flag("airPlay"),
                castMenu = flag("castMenu"),
                maxPlayers = (json["maxPlayers"] as? JsonPrimitive)?.doubleOrNull?.toInt() ?: 1,
            )
        }
    }
}

/** One served asset. Text travels as text, never base64. */
data class BridgeAsset(val uri: String, val contentType: String, val text: String)

data class NowPlaying(val title: String, val subtitle: String?, val artworkUrl: String?)

/** Resolved by `player-core`: native applies it, never defaults it. */
data class RecoveryPolicy(val escalationWindowMs: Double, val maxReloadAttempts: Int, val reloadDelaysMs: List<Double>) {
    companion object {
        /** What the engine holds before a load names its own; `player-core`'s defaults. */
        val DEFAULT = RecoveryPolicy(escalationWindowMs = 10_000.0, maxReloadAttempts = 3, reloadDelaysMs = listOf(2000.0, 4000.0, 8000.0))
    }
}

data class BridgeLiveSpec(
    val url: String,
    val baseUrl: String,
    val keyUri: String?,
    val keyHex: String?,
    val refreshSec: Double,
)

/** A rectangle in the web view's coordinates, in CSS pixels. */
data class InlineFrame(val x: Double, val y: Double, val width: Double, val height: Double)

data class CreateOptions(val protocolVersion: Double, val skipBackSeconds: Double, val skipForwardSeconds: Double)

data class LoadArgs(
    val playerId: String,
    val loadId: String,
    val generation: Int,
    val masterUri: String,
    val assets: List<BridgeAsset>,
    val keyHex: String?,
    /** The host's connection measure in bits per second, a hint to start the adaptive logic from; null for none. */
    val bandwidthEstimate: Double?,
    val startPosition: Double?,
    val recovery: RecoveryPolicy,
    val nowPlaying: NowPlaying?,
)

data class Snapshot(
    val currentTime: Double,
    /** 0 until known; null while unbounded (live). */
    val duration: Double?,
    val bufferedEnd: Double,
    val playing: Boolean,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("currentTime", currentTime)
        put("duration", duration)
        put("bufferedEnd", bufferedEnd)
        put("playing", playing)
    }
}

data class PendingReload(val reason: String, val attempt: Int)

data class ResumeResult(val loadId: String?, val snapshot: Snapshot, val pendingReload: PendingReload?) {
    fun toJson(): JsonObject = buildJsonObject {
        put("loadId", loadId)
        put("snapshot", snapshot.toJson())
        if (pendingReload != null) {
            put("pendingReload", buildJsonObject {
                put("reason", pendingReload.reason)
                put("attempt", pendingReload.attempt)
            })
        }
    }
}

/** `AdapterAudioTrack` in `player-core`. */
data class AudioTrack(val id: String, val lang: String?, val label: String) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        if (lang != null) put("lang", lang)
        put("label", label)
    }
}

/** `AdapterVariant` in `player-core`. */
data class Variant(val id: String, val height: Int?, val bandwidth: Long) {
    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        if (height != null) put("height", height)
        put("bandwidth", bandwidth)
    }
}

fun List<AudioTrack>.toJson(): JsonArray = buildJsonArray { forEach { add(it.toJson()) } }

@JvmName("variantsToJson")
fun List<Variant>.toJson(): JsonArray = buildJsonArray { forEach { add(it.toJson()) } }

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** One decoded, validated call. [playerId] is null for the calls that name no player. */
sealed interface BridgeCall {
    val playerId: String? get() = null

    data object GetInfo : BridgeCall
    data object Reset : BridgeCall
    data class Create(val options: CreateOptions) : BridgeCall
    data class Load(val args: LoadArgs) : BridgeCall {
        override val playerId get() = args.playerId
    }
    data class PutAssets(override val playerId: String, val generation: Int, val assets: List<BridgeAsset>) : BridgeCall
    data class PutLive(override val playerId: String, val generation: Int, val uri: String, val spec: BridgeLiveSpec) :
        BridgeCall
    data class ReleaseAssets(override val playerId: String, val generation: Int) : BridgeCall
    data class Reattach(override val playerId: String, val loadId: String) : BridgeCall
    data class Play(override val playerId: String) : BridgeCall
    data class Pause(override val playerId: String) : BridgeCall
    data class Seek(override val playerId: String, val position: Double, val exact: Boolean) : BridgeCall
    data class SetRate(override val playerId: String, val rate: Double) : BridgeCall
    data class SetVariant(override val playerId: String, val id: String) : BridgeCall
    data class SetAudioTrack(override val playerId: String, val id: String) : BridgeCall
    data class WarmChunks(
        override val playerId: String,
        val loadId: String,
        val schedules: JsonArray,
        val leadSeconds: Double,
        val warmBytes: Int,
    ) : BridgeCall
    data class SetInlineFrame(override val playerId: String, val frame: InlineFrame?) : BridgeCall
    data class SetMuted(override val playerId: String, val muted: Boolean) : BridgeCall
    data class SetSubtitleTrack(override val playerId: String, val label: String?) : BridgeCall
    data class StartPictureInPicture(override val playerId: String) : BridgeCall
    data class ShowAirPlayPicker(override val playerId: String) : BridgeCall

    data class SetCastMenu(override val playerId: String, val menu: CastMenu) : BridgeCall

    /** [texts] are what the controls say in the host's language; null keeps the last, or English. */
    data class EnterFullscreen(override val playerId: String, val texts: Map<String, String>?) : BridgeCall
    data class ExitFullscreen(override val playerId: String) : BridgeCall
    data class Resumed(override val playerId: String) : BridgeCall
    data class Destroy(override val playerId: String) : BridgeCall

    companion object {
        /** The capability each gated method needs; checked before its arguments are looked at. */
        fun capabilityOf(method: String): ((BridgeCapabilities) -> Boolean)? = when (method) {
            "setVariant" -> BridgeCapabilities::variantSwitching
            "putLive" -> BridgeCapabilities::live
            "warmChunks" -> BridgeCapabilities::chunkWarming
            "setInlineFrame" -> BridgeCapabilities::inlineVideo
            "setMuted" -> BridgeCapabilities::muting
            "setSubtitleTrack" -> BridgeCapabilities::subtitleSelection
            "startPictureInPicture" -> BridgeCapabilities::pictureInPicture
            "showAirPlayPicker" -> BridgeCapabilities::airPlay
            "setCastMenu" -> BridgeCapabilities::castMenu
            else -> null
        }

        /** Throws [BridgeRejection] with `invalid-argument`; [IllegalArgumentException] for a method the bridge lacks. */
        fun decode(method: String, json: JsonObject): BridgeCall {
            val args = Args(json, method)
            return when (method) {
                "getInfo" -> GetInfo
                "reset" -> Reset
                "create" -> Create(
                    CreateOptions(
                        protocolVersion = args.number("protocolVersion"),
                        skipBackSeconds = args.number("skipBackSeconds"),
                        skipForwardSeconds = args.number("skipForwardSeconds"),
                    ),
                )
                "load" -> Load(decodeLoad(args))
                "putAssets" -> {
                    val generation = args.generation()
                    PutAssets(args.string("playerId"), generation, args.assets(generation))
                }
                "putLive" -> {
                    val spec = args.obj("spec")
                    PutLive(
                        playerId = args.string("playerId"),
                        generation = args.generation(),
                        uri = args.string("uri"),
                        spec = BridgeLiveSpec(
                            url = spec.string("url"),
                            baseUrl = spec.string("baseUrl"),
                            keyUri = spec.optString("keyUri")?.takeIf { it.isNotEmpty() },
                            keyHex = spec.optKeyHex("keyHex"),
                            refreshSec = spec.number("refreshSec"),
                        ),
                    )
                }
                "releaseAssets" -> ReleaseAssets(args.string("playerId"), args.generation())
                "reattach" -> Reattach(args.string("playerId"), args.string("loadId"))
                "play" -> Play(args.string("playerId"))
                "pause" -> Pause(args.string("playerId"))
                "seek" -> Seek(
                    args.string("playerId"),
                    args.number("position").also { if (it < 0) args.invalid("position is not negative") },
                    args.optBoolean("exact") ?: false,
                )
                "setRate" -> SetRate(
                    args.string("playerId"),
                    args.number("rate").also { if (it <= 0) args.invalid("rate is positive") },
                )
                "setVariant" -> SetVariant(args.string("playerId"), args.string("id"))
                "setAudioTrack" -> SetAudioTrack(args.string("playerId"), args.string("id"))
                "warmChunks" -> WarmChunks(
                    playerId = args.string("playerId"),
                    loadId = args.string("loadId"),
                    // ChunkBoundary[][]: an array of schedules, each an array of boundaries.
                    schedules = args.array("schedules").also { schedules ->
                        schedules.forEachIndexed { i, schedule ->
                            val boundaries = schedule as? JsonArray ?: args.invalid("schedules[$i] is not an array")
                            boundaries.forEachIndexed { j, boundary ->
                                if (boundary !is JsonObject) args.invalid("schedules[$i][$j] is not an object")
                                // Complete, or refused: a dropped boundary would merge its neighbours and warm
                                // the wrong chunk.
                                val url = boundary["url"] as? JsonPrimitive
                                if (url == null || !url.isString || numberOf(boundary["start"]) == null || numberOf(boundary["end"]) == null) {
                                    args.invalid("schedules[$i][$j] has no url, start and end")
                                }
                            }
                        }
                    },
                    leadSeconds = args.number("leadSeconds"),
                    warmBytes = args.count("warmBytes"),
                )
                "setInlineFrame" -> {
                    val frame = args.optObj("frame")?.let { frame ->
                        val width = frame.number("width")
                        val height = frame.number("height")
                        if (width <= 0 || height <= 0) args.invalid("frame has a positive width and height")
                        InlineFrame(frame.number("x"), frame.number("y"), width, height)
                    }
                    SetInlineFrame(args.string("playerId"), frame)
                }
                "setMuted" -> SetMuted(args.string("playerId"), args.optBoolean("muted") ?: args.invalid("muted is required"))
                "setSubtitleTrack" -> SetSubtitleTrack(args.string("playerId"), args.optString("label"))
                "startPictureInPicture" -> StartPictureInPicture(args.string("playerId"))
                "showAirPlayPicker" -> ShowAirPlayPicker(args.string("playerId"))
                "setCastMenu" -> {
                    val playerId = args.string("playerId")
                    val menu = args.obj("menu")
                    SetCastMenu(
                        playerId,
                        CastMenu(
                            angles = menu.choices("angles"),
                            activeAngleId = menu.optString("activeAngleId"),
                            qualities = menu.choices("qualities"),
                            activeQualityId = menu.string("activeQualityId"),
                        ),
                    )
                }
                "enterFullscreen" -> EnterFullscreen(args.string("playerId"), args.optObj("texts")?.strings())
                "exitFullscreen" -> ExitFullscreen(args.string("playerId"))
                "resumed" -> Resumed(args.string("playerId"))
                "destroy" -> Destroy(args.string("playerId"))
                else -> throw IllegalArgumentException("No bridge method $method")
            }
        }

        private fun decodeLoad(args: Args): LoadArgs {
            val generation = args.generation()
            val recovery = args.obj("recovery")
            val nowPlaying = args.optObj("nowPlaying")
            args.optObj("requestHeaders")
            val masterUri = args.string("masterUri")
            val load = LoadArgs(
                playerId = args.string("playerId"),
                loadId = args.string("loadId"),
                generation = generation,
                masterUri = masterUri,
                assets = args.assets(generation),
                keyHex = args.optKeyHex("keyHex"),
                // A hint that is not a usable number is no hint.
                bandwidthEstimate = args.optNumber("bandwidthEstimate")?.takeIf { it > 0 },
                startPosition = args.optNumber("startPosition")?.also {
                    if (it < 0) args.invalid("startPosition is not negative")
                },
                recovery = RecoveryPolicy(
                    escalationWindowMs = recovery.number("escalationWindowMs"),
                    maxReloadAttempts = recovery.count("maxReloadAttempts"),
                    reloadDelaysMs = recovery.array("reloadDelaysMs").mapIndexed { i, delay ->
                        numberOf(delay) ?: recovery.invalid("reloadDelaysMs[$i] is not a number")
                    },
                ),
                nowPlaying = nowPlaying?.let {
                    NowPlaying(it.string("title"), it.optString("subtitle"), it.optString("artworkUrl"))
                },
            )
            if (!masterUri.startsWith(ASSET_URI_PREFIX)) args.invalid("masterUri is a luminary://asset/ address")
            return load
        }
    }
}

private val KEY_HEX = Regex("^[0-9a-fA-F]{32}$")

private fun numberOf(value: JsonElement?): Double? {
    val primitive = value as? JsonPrimitive ?: return null
    if (primitive.isString || primitive is JsonNull) return null
    return primitive.doubleOrNull?.takeIf { it.isFinite() }
}

/** Reads one JSON object's fields as `bridge.ts` declares them; any mismatch is `invalid-argument`. */
private class Args(private val json: JsonObject, private val path: String) {
    fun invalid(message: String): Nothing = throw BridgeRejection(BridgeErrorCode.INVALID_ARGUMENT, "$path: $message")

    private fun present(key: String): JsonElement? = json[key]

    fun string(key: String): String = optString(key) ?: invalid("$key is required")

    fun optString(key: String): String? {
        val value = present(key) ?: return null
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString) invalid("$key is not a string")
        return primitive.content
    }

    fun number(key: String): Double = optNumber(key) ?: invalid("$key is required")

    /** A non-negative integer that fits an Int32: a count past that names nothing a player has. */
    fun count(key: String): Int {
        val value = number(key)
        if (value < 0 || value % 1.0 != 0.0 || value > Int.MAX_VALUE) invalid("$key is a non-negative integer")
        return value.toInt()
    }

    fun optNumber(key: String): Double? {
        val value = present(key) ?: return null
        return numberOf(value) ?: invalid("$key is not a finite number")
    }

    fun optBoolean(key: String): Boolean? {
        val value = present(key) ?: return null
        val primitive = value as? JsonPrimitive
        if (primitive == null || primitive.isString) invalid("$key is not a boolean")
        return primitive.booleanOrNull ?: invalid("$key is not a boolean")
    }

    fun obj(key: String): Args = optObj(key) ?: invalid("$key is required")

    /** An array of `{ id, label }`, each a string; refused whole when one is not. */
    fun choices(key: String): List<CastChoice> = array(key).mapIndexed { i, element ->
        val choice = element as? JsonObject ?: invalid("$key[$i] is not an object")
        val id = (choice["id"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val label = (choice["label"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (id == null || label == null) invalid("$key[$i] has no id and label")
        CastChoice(id, label)
    }

    fun optObj(key: String): Args? {
        val value = present(key) ?: return null
        return Args(value as? JsonObject ?: invalid("$key is not an object"), "$path.$key")
    }

    /** Every field of this object, each a string. */
    fun strings(): Map<String, String> = json.mapValues { (key, value) ->
        val primitive = value as? JsonPrimitive
        if (primitive == null || !primitive.isString) invalid("texts.$key is a string")
        primitive.content
    }

    fun array(key: String): JsonArray = present(key) as? JsonArray ?: invalid("$key is not an array")

    fun optKeyHex(key: String): String? =
        optString(key)?.also { if (!KEY_HEX.matches(it)) invalid("$key is 32 hex characters") }

    fun generation(): Int {
        val generation = number("generation")
        if (generation < 0 || generation % 1.0 != 0.0 || generation > Int.MAX_VALUE) {
            invalid("generation is a non-negative integer")
        }
        return generation.toInt()
    }

    /** Every asset must be addressed to [generation]. */
    fun assets(generation: Int): List<BridgeAsset> {
        val prefix = "$ASSET_URI_PREFIX$generation/"
        return array("assets").mapIndexed { i, element ->
            val asset = Args(element as? JsonObject ?: invalid("assets[$i] is not an object"), "$path.assets[$i]")
            BridgeAsset(asset.string("uri"), asset.string("contentType"), asset.string("text")).also {
                if (!it.uri.startsWith(prefix)) invalid("${it.uri} is not an asset of generation $generation")
            }
        }
    }
}

/** One entry of the TV's menu: what the page calls it, and what the viewer reads. */
data class CastChoice(val id: String, val label: String)

/** The page's angles and qualities, with its current choice, for the TV's menu. */
data class CastMenu(
    val angles: List<CastChoice>,
    val activeAngleId: String?,
    val qualities: List<CastChoice>,
    val activeQualityId: String,
)
