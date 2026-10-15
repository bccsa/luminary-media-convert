package org.bccsa.luminary.player.conformance

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The native side of a conformance scenario, replayed against a [ConformanceHarness].
 * Mirrors `src/test-support/conformance/{load,tsRunner}.ts`; `conformance/README.md` is normative.
 */
object ScenarioRunner {
    /**
     * `player-native/conformance`. Gradle runs unit tests from the module directory (`android/`);
     * `LUMINARY_CONFORMANCE_DIR` overrides it.
     */
    val conformanceDirectory: File
        get() = System.getenv("LUMINARY_CONFORMANCE_DIR")?.let(::File) ?: File("../conformance")

    class ScenarioFile(val file: String, val scenario: JsonObject) {
        override fun toString() = file
    }

    /** Every JSON file in the directory, validated; throws naming the first that is not a scenario. */
    fun loadScenarios(directory: File = conformanceDirectory): List<ScenarioFile> {
        val files = directory.listFiles { file -> file.isFile && file.name.endsWith(".json") }
            ?: throw MatchError("No conformance directory at ${directory.absolutePath}")
        return files.sortedBy { it.name }.map { file ->
            val scenario = Json.parseToJsonElement(file.readText())
            try {
                validate(scenario)
            } catch (error: MatchError) {
                throw MatchError("${file.name}: ${error.message}")
            }
            ScenarioFile(file.name, scenario as JsonObject)
        }
    }

    val defaultCapabilities: Map<String, JsonElement> = mapOf(
        "variantSwitching" to JsonPrimitive(false),
        "pictureInPicture" to JsonPrimitive(false),
        "renderText" to JsonPrimitive(false),
        "live" to JsonPrimitive(false),
        "chunkWarming" to JsonPrimitive(false),
        "backgroundAudio" to JsonPrimitive(false),
        "inlineVideo" to JsonPrimitive(false),
        "muting" to JsonPrimitive(false),
        "subtitleSelection" to JsonPrimitive(false),
        "airPlay" to JsonPrimitive(false),
        "maxPlayers" to JsonPrimitive(1),
    )

    /** Runs every native step; throws a [MatchError] naming the first that fails. */
    fun run(scenario: JsonObject, harness: ConformanceHarness) {
        val capabilities = defaultCapabilities + ((scenario["capabilities"] as? JsonObject) ?: emptyMap())
        harness.start(JsonObject(capabilities))

        val run = NativeRun(harness)
        val steps = scenario["steps"] as? JsonArray ?: throw MatchError("steps is required")
        steps.forEachIndexed { index, step ->
            val body = step as JsonObject
            if (!appliesToNative(body)) return@forEachIndexed
            val kind = stepKind(body)
            try {
                run.step(kind, body[kind]!!)
            } catch (error: MatchError) {
                throw MatchError("step $index ($kind): ${error.message}")
            }
        }
        try {
            run.expectNoEvents()
        } catch (error: MatchError) {
            throw MatchError("end of scenario: ${error.message}")
        }
    }
}

// ---------------------------------------------------------------------------
// The format
// ---------------------------------------------------------------------------

private val STEP_SIDES = mapOf(
    "drive" to setOf("ts"),
    "call" to setOf("ts", "native"),
    "event" to setOf("ts", "native"),
    "engine" to setOf("native"),
    "advanceClock" to setOf("ts", "native"),
    "expectNoEvents" to setOf("native"),
    "expectEngine" to setOf("native"),
    "expectAdapter" to setOf("ts"),
    "expectState" to setOf("ts"),
    "expectNoCalls" to setOf("ts"),
    "route" to setOf("native"),
)

private val STEP_KEYS = mapOf(
    "drive" to setOf("start", "controller", "adapter", "args", "rejects"),
    "call" to setOf("method", "args", "match", "result", "rejects"),
    "event" to setOf("name", "payload"),
    "route" to setOf("uri", "expect"),
)

private val TOP_LEVEL_KEYS = setOf("\$schema", "name", "description", "capabilities", "fetch", "steps")

private val BRIDGE_ERROR_CODES = setOf(
    "unsupported", "unknown-player", "stale-generation", "invalid-argument", "protocol-mismatch", "engine",
)

/** The `FakeEngine` vocabulary; adding a signal is a change to the format. */
val ENGINE_SIGNALS = setOf(
    "readyToPlay", "playing", "paused", "buffering", "seeked", "ended",
    "tracks", "variants", "failed", "bufferedTo", "position", "rate", "muted", "airplay",
)

private fun stepKind(step: JsonObject): String {
    val kinds = step.keys.filter { it != "only" && it != "note" }
    val kind = kinds.singleOrNull()
    if (kind == null || kind !in STEP_SIDES) throw MatchError("a step names exactly one kind; got ${step.keys.sorted()}")
    return kind
}

private fun appliesToNative(step: JsonObject): Boolean {
    val kind = stepKind(step)
    val only = step["only"] ?: return "native" in STEP_SIDES.getValue(kind)
    val side = only.stringOrNull()
    if (side == null || side !in STEP_SIDES.getValue(kind)) throw MatchError("a $kind step cannot be restricted to $only")
    return side == "native"
}

private fun validate(scenario: JsonElement) {
    if (scenario !is JsonObject) throw MatchError("a scenario is an object")
    scenario.keys.firstOrNull { it !in TOP_LEVEL_KEYS }?.let { throw MatchError("scenario: unknown key $it") }
    if (scenario["name"].stringOrNull().isNullOrEmpty()) throw MatchError("name is required")
    scenario["capabilities"]?.let { capabilities ->
        if (capabilities !is JsonObject) throw MatchError("capabilities is an object")
        capabilities.keys.firstOrNull { it !in ScenarioRunner.defaultCapabilities }
            ?.let { throw MatchError("capabilities: unknown key $it") }
    }
    val steps = scenario["steps"] as? JsonArray
    if (steps.isNullOrEmpty()) throw MatchError("steps is a non-empty array")
    steps.forEachIndexed { index, step ->
        val where = "step $index"
        if (step !is JsonObject) throw MatchError("$where: a step is an object")
        val kind = stepKind(step)
        appliesToNative(step)
        val value = step.getValue(kind)
        STEP_KEYS[kind]?.let { allowed ->
            if (value !is JsonObject) throw MatchError("$where: $kind takes an object")
            value.keys.firstOrNull { it !in allowed }?.let { throw MatchError("$where ($kind): unknown key $it") }
        }
        (value as? JsonObject)?.get("rejects")?.let { rejects ->
            if (rejects.stringOrNull() !in BRIDGE_ERROR_CODES) throw MatchError("$where: $rejects is not a bridge error code")
        }
        when (kind) {
            "call" -> {
                value as JsonObject
                if (value["method"].stringOrNull() == null) throw MatchError("$where: call.method is required")
                if ("result" in value && "rejects" in value) throw MatchError("$where: result or rejects, not both")
            }
            "event" -> {
                value as JsonObject
                if (value["name"].stringOrNull() == null || value["payload"] !is JsonObject) {
                    throw MatchError("$where: event takes a name and a payload object")
                }
            }
            "engine" -> {
                val signal = (value as? JsonObject)?.get("signal").stringOrNull()
                    ?: throw MatchError("$where: engine takes { signal, ...args }")
                if (signal !in ENGINE_SIGNALS) throw MatchError("$where: unknown engine signal $signal")
            }
            "advanceClock" -> {
                val seconds = value.numberOrNull()
                if (seconds == null || seconds <= 0) throw MatchError("$where: advanceClock takes seconds > 0")
            }
            "expectNoEvents", "expectNoCalls" ->
                if (!jsonEquals(value, JsonPrimitive(true))) throw MatchError("$where: $kind takes true")
            "expectAdapter", "expectState" ->
                if (value !is JsonObject) throw MatchError("$where: $kind takes an object")
            "route" -> {
                value as JsonObject
                if (value["uri"].stringOrNull() == null || "expect" !in value) {
                    throw MatchError("$where: route takes a uri and an expect")
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Replaying
// ---------------------------------------------------------------------------

private class NativeRun(private val harness: ConformanceHarness) {
    private val refs = Refs()
    private val pending = ArrayDeque<JsonObject>()

    fun step(kind: String, body: JsonElement) {
        when (kind) {
            "call" -> call(body as JsonObject)
            "event" -> event(body as JsonObject)
            "engine" -> {
                body as JsonObject
                val args = refs.issue(JsonObject(body - "signal")) as JsonObject
                harness.engine(body["signal"].stringOrNull()!!, args)
            }
            "advanceClock" -> harness.advanceClock(body.numberOrNull()!!)
            "expectNoEvents" -> expectNoEvents()
            "expectEngine" -> refs.assert(JsonArray(harness.drainEngineCalls()), body, "engine")
            "route" -> {
                body as JsonObject
                val uri = body["uri"].stringOrNull()!!
                refs.assert(harness.route(uri).json, body.getValue("expect"), "route($uri)")
            }
            else -> throw MatchError("$kind has no native side")
        }
    }

    private fun call(body: JsonObject) {
        val method = body["method"].stringOrNull()!!
        val args = refs.issue(body["args"] ?: JsonObject(emptyMap())) as JsonObject
        val rejects = body["rejects"]
        when (val result = harness.call(method, args)) {
            is CallResult.Resolved -> {
                if (rejects != null) throw MatchError("$method: expected a $rejects rejection, got ${result.value}")
                body["result"]?.let { refs.assert(result.value, it, "$method.result") }
            }
            is CallResult.Rejected -> {
                if (rejects == null) throw MatchError("$method: rejected ${result.code} (${result.message})")
                if (rejects.stringOrNull() != result.code) {
                    throw MatchError("$method: expected a $rejects rejection, got ${result.code}")
                }
            }
        }
    }

    private fun event(body: JsonObject) {
        if (pending.isEmpty()) pending.addAll(harness.drainEvents())
        val name = body["name"].stringOrNull()!!
        val emitted = pending.removeFirstOrNull() ?: throw MatchError("expected a $name event; none was emitted")
        if (emitted["name"].stringOrNull() != name) {
            throw MatchError("expected a $name event, got ${emitted["name"] ?: "an unnamed one"}")
        }
        refs.assert(emitted["payload"], body.getValue("payload"), "$name.payload")
    }

    fun expectNoEvents() {
        pending.addAll(harness.drainEvents())
        if (pending.isNotEmpty()) {
            throw MatchError("unasserted events: ${pending.joinToString { it["name"].stringOrNull() ?: "?" }}")
        }
    }
}
