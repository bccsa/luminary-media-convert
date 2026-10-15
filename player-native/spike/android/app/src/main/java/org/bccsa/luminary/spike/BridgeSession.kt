package org.bccsa.luminary.spike

import android.app.Activity
import android.content.Context
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import org.bccsa.luminary.player.BridgeRejection
import org.bccsa.luminary.player.PROTOCOL_VERSION
import org.bccsa.luminary.player.exoPlayerRegistry

/**
 * The TypeScript half, played by hand: every bridge call the Android plugin supports, made the way
 * `NativeBridgeAdapter` makes it, against the registry the plugin itself runs. Events are followed
 * the way the adapter and `PlayerController` follow them: a stale `loadId` is dropped, and a chosen
 * audio track is handed back once a rebuilt list carries it. Main thread only.
 */
class BridgeSession(
    context: Context,
    activity: () -> Activity?,
    private val payload: Payload,
    private val log: (String) -> Unit,
    /** Called after anything the screen shows has changed. */
    private val changed: () -> Unit,
) {
    class Choice(val id: String, val label: String)

    private val registry = exoPlayerRegistry(context, activity, ::onEvent)

    var playerId: String? = null
        private set
    var loadId: String? = null
        private set
    var generation = 0
        private set
    var visitIndex = 0
        private set
    private var loads = 0
    private val sent = HashSet<String>()

    // What the events have said.
    var currentTime = 0.0
        private set
    var duration: Double? = 0.0
        private set
    var bufferedEnd = 0.0
        private set
    var playing = false
        private set
    var waiting = false
        private set
    var presentation = "inline"
        private set
    var rate = 1.0
        private set
    var variants: List<Choice> = emptyList()
        private set
    var activeVariant = "auto"
        private set
    var audioTracks: List<Choice> = emptyList()
        private set
    var activeAudio: String? = null
        private set

    /** The viewer's language, handed back whenever a load rebuilds the list. */
    private var chosenAudio: String? = null

    val visitName: String get() = payload.name(payload.visits[visitIndex])

    // Calls.

    private fun call(method: String, args: JsonObject, describe: String = args.toString()): JsonElement? = try {
        registry.call(method, args).also { result ->
            log("call    $method $describe -> $result")
        }
    } catch (rejection: BridgeRejection) {
        log("call    $method $describe REJECTED ${rejection.code.wire}: ${rejection.message}")
        null
    } finally {
        changed()
    }

    private fun player(vararg fields: Pair<String, Any>) = buildJsonObject {
        put("playerId", playerId ?: "none")
        for ((key, value) in fields) {
            when (value) {
                is String -> put(key, value)
                is Number -> put(key, value)
                is Boolean -> put(key, value)
            }
        }
    }

    fun getInfo() = call("getInfo", JsonObject(emptyMap()))

    fun reset() {
        call("reset", JsonObject(emptyMap()))
        forgetPlayer()
    }

    /** `create`, then the first angle, as `createNativePlayer` and a first `load()` do. */
    fun create() {
        val result = call("create", buildJsonObject {
            put("protocolVersion", PROTOCOL_VERSION)
            put("skipBackSeconds", 10)
            put("skipForwardSeconds", 10)
        }) ?: return
        forgetPlayer()
        playerId = result.jsonObject.getValue("playerId").jsonPrimitive.content
        generation = payload.visits.first().generation
        load(0, startPosition = null)
    }

    fun destroy() {
        call("destroy", player())
        forgetPlayer()
    }

    private fun forgetPlayer() {
        playerId = null
        loadId = null
        sent.clear()
        playing = false
        waiting = false
        currentTime = 0.0
        duration = 0.0
        bufferedEnd = 0.0
        variants = emptyList()
        audioTracks = emptyList()
        activeAudio = null
        presentation = "inline"
        changed()
    }

    /**
     * A `load` of one visit in the current generation. Its assets are the ones this player has not
     * been sent yet, from this visit and those before it, addressed to [generation].
     */
    fun load(index: Int, startPosition: Double?) {
        val visit = payload.visits[index]
        val from = "luminary://asset/${visit.generation}/"
        val to = "luminary://asset/$generation/"
        val needed = (payload.visits.take(index).flatMap { it.assets } + visit.assets)
            .distinctBy { it.uri }
            .filter { it.uri.replace(from, to) !in sent }
        val nextLoad = "load${++loads}"
        val masterUri = visit.masterUri.replace(from, to)
        val args = buildJsonObject {
            put("playerId", playerId ?: "none")
            put("loadId", nextLoad)
            put("generation", generation)
            put("masterUri", masterUri)
            put("assets", buildJsonArray {
                for (asset in needed) {
                    add(buildJsonObject {
                        put("uri", asset.uri.replace(from, to))
                        put("contentType", asset.contentType)
                        put("text", asset.text.replace(from, to))
                    })
                }
            })
            payload.keyHex?.let { put("keyHex", it) }
            startPosition?.let { put("startPosition", it) }
            put("recovery", buildJsonObject {
                put("escalationWindowMs", 10_000)
                put("maxReloadAttempts", 3)
                put("reloadDelaysMs", buildJsonArray { listOf(2000, 4000, 8000).forEach { add(JsonPrimitive(it)) } })
            })
            put("nowPlaying", buildJsonObject {
                put("title", payload.name(visit))
                put("subtitle", "LMC spike")
            })
        }
        // The key travels in `load`: never logged, here or in the plugin.
        val describe = "gen=$generation ${payload.name(visit)} master=$masterUri assets=${needed.size} start=${startPosition ?: "-"}"
        loadId = nextLoad
        if (call("load", args, describe) == null) return
        sent += needed.map { it.uri.replace(from, to) }
        visitIndex = index
        variants = emptyList()
        changed()
    }

    /** An angle switch the way `setAngle` does it: same generation, from the current position. */
    fun switchTo(index: Int) {
        val resume = playing
        load(index, startPosition = currentTime.takeIf { it > 0 })
        if (resume) play()
    }

    /** A new generation, as a fresh controller `load()` makes one: the old is released, then replaced. */
    fun newGeneration() {
        if (playerId == null) return
        val resume = playing
        call("releaseAssets", player("generation" to generation))
        generation++
        load(visitIndex, startPosition = currentTime.takeIf { it > 0 })
        if (resume) play()
    }

    fun reattach() {
        val next = "load${++loads}"
        loadId = next
        call("reattach", player("loadId" to next))
    }

    fun play() = call("play", player())

    fun pause() = call("pause", player())

    fun seek(position: Double, exact: Boolean) =
        call("seek", player("position" to position.coerceAtLeast(0.0), "exact" to exact))

    fun setRate(rate: Double) {
        if (call("setRate", player("rate" to rate)) != null) this.rate = rate
    }

    fun setVariant(id: String) {
        if (call("setVariant", player("id" to id)) != null) activeVariant = id
    }

    fun setAudioTrack(id: String) {
        chosenAudio = id
        call("setAudioTrack", player("id" to id))
    }

    fun enterFullscreen() = call("enterFullscreen", player())

    fun exitFullscreen() = call("exitFullscreen", player())

    fun resumed() = call("resumed", player())

    fun release() {
        runCatching { registry.call("reset", JsonObject(emptyMap())) }
    }

    // Events.

    private fun onEvent(name: String, payload: JsonObject) {
        val eventLoad = payload["loadId"]?.jsonPrimitive?.contentOrNull
        if (eventLoad != loadId) {
            log("event   $name from $eventLoad dropped: stale")
            return
        }
        when (name) {
            "timeupdate" -> currentTime = payload.number("currentTime") ?: currentTime
            "progress" -> bufferedEnd = payload.number("bufferedEnd") ?: bufferedEnd
            "durationchange", "loadedmetadata" -> duration = payload.number("duration")
            "playing" -> {
                playing = true
                waiting = false
            }
            "pause", "ended" -> {
                playing = false
                waiting = false
            }
            "waiting" -> waiting = true
            "seeked" -> waiting = false
            "presentationchange" -> presentation = payload["state"]?.jsonPrimitive?.content ?: presentation
            "variants-updated" -> variants = payload.getValue("variants").jsonArray.map { element ->
                val variant = element.jsonObject
                val height = variant["height"]?.jsonPrimitive?.longOrNull
                val bandwidth = variant["bandwidth"]?.jsonPrimitive?.longOrNull ?: 0
                val label = (height?.let { "${it}p" } ?: "?") + " · %.1f Mbps".format(bandwidth / 1e6)
                Choice(variant.getValue("id").jsonPrimitive.content, label)
            }.also { list ->
                // The engine drops a pin the new ladder cannot honour, and says so with this list.
                if (list.none { it.id == activeVariant }) activeVariant = "auto"
            }
            "audiotracks-updated" -> {
                audioTracks = payload.getValue("tracks").jsonArray.map { element ->
                    val track = element.jsonObject
                    Choice(track.getValue("id").jsonPrimitive.content, track.getValue("label").jsonPrimitive.content)
                }
                activeAudio = payload["activeId"]?.takeUnless { it is JsonNull }?.jsonPrimitive?.content
                handBackAudio()
            }
        }
        if (name != "timeupdate" && name != "progress") log("event   $name ${payload.withoutStamps()}")
        changed()
    }

    /** The controller's rule: a rebuilt list starts at the engine's default, so the choice goes back. */
    private fun handBackAudio() {
        val chosen = chosenAudio ?: return
        if (activeAudio != chosen && audioTracks.any { it.id == chosen }) {
            log("hand    back audio choice $chosen")
            call("setAudioTrack", player("id" to chosen))
        }
    }

    private fun JsonObject.number(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull

    private fun JsonObject.withoutStamps() = JsonObject(filterKeys { it != "playerId" && it != "loadId" })
}
