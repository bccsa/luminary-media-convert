package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The test seam plan 02 builds for the conformance runner: a `PlayerRegistry` wired to a
 * `FakeEngine` and a virtual clock. The Swift protocol has the same members;
 * `conformance/README.md` describes each one.
 */
interface ConformanceHarness {
    /** Starts a registry reporting these capabilities (every key present). */
    fun start(capabilities: JsonObject)

    /** Goes through the same decoding and validation as `LuminaryPlayerPlugin`. */
    fun call(method: String, args: JsonObject): CallResult

    fun engine(signal: String, args: JsonObject)

    fun advanceClock(seconds: Double)

    /** `{ "name", "payload" }` per event, in emission order, since the last drain. */
    fun drainEvents(): List<JsonObject>

    /** `{ "method", …args }` per engine call, since the last drain. */
    fun drainEngineCalls(): List<JsonObject>

    /** Through the `UriRouter` of the most recently created player, even once destroyed. */
    fun route(uri: String): RouteResult
}

sealed interface CallResult {
    /** A call that answers nothing resolves with an empty object. */
    data class Resolved(val value: JsonElement) : CallResult

    /** [code] is one of the bridge's rejection codes. */
    data class Rejected(val code: String, val message: String) : CallResult
}

sealed interface RouteResult {
    class Served(val bytes: ByteArray, val contentType: String) : RouteResult

    /** `not-found` or `key-required`. */
    data class Failed(val code: String) : RouteResult

    /** The JSON a scenario's `route.expect` is matched against. */
    val json: JsonObject
        get() = when (this) {
            is Served -> {
                val view = mutableMapOf<String, JsonElement>(
                    "contentType" to JsonPrimitive(contentType),
                    "bytes" to JsonPrimitive(bytes.size),
                    "hex" to JsonPrimitive(bytes.joinToString("") { "%02x".format(it) }),
                )
                val text = runCatching {
                    Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString()
                }.getOrNull()
                if (text != null) view["text"] = JsonPrimitive(text)
                JsonObject(view)
            }
            is Failed -> JsonObject(mapOf("error" to JsonPrimitive(code)))
        }
}
