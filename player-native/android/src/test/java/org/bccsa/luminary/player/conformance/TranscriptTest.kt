package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * Answers from the reference native side's recorded conversation
 * (`conformance/selftest/transcripts/`), and fails the moment this runner drives the
 * harness differently from the TypeScript one.
 */
private class TranscriptHarness(private val ops: JsonArray) : ConformanceHarness {
    private var cursor = 0
    val finished get() = cursor == ops.size

    private fun next(op: String, inputs: Map<String, JsonElement>): JsonObject {
        if (cursor >= ops.size) throw MatchError("op $cursor: $op $inputs, but the transcript has ended")
        val recorded = ops[cursor] as JsonObject
        val matches = recorded["op"].stringOrNull() == op && inputs.all { (key, value) -> jsonEquals(recorded[key], value) }
        if (!matches) {
            throw MatchError("op $cursor: this runner sent ${JsonObject(inputs + ("op" to JsonPrimitive(op)))}, the TypeScript runner sent $recorded")
        }
        cursor += 1
        return recorded
    }

    override fun start(capabilities: JsonObject) {
        next("start", mapOf("capabilities" to capabilities))
    }

    override fun call(method: String, args: JsonObject): CallResult {
        val result = next("call", mapOf("method" to JsonPrimitive(method), "args" to args)).getValue("result") as JsonObject
        val rejected = result["rejected"] as? JsonObject
        return if (rejected != null) {
            CallResult.Rejected(rejected["code"].stringOrNull()!!, rejected["message"].stringOrNull() ?: "")
        } else {
            CallResult.Resolved(result.getValue("resolved"))
        }
    }

    override fun engine(signal: String, args: JsonObject) {
        next("engine", mapOf("signal" to JsonPrimitive(signal), "args" to args))
    }

    override fun advanceClock(seconds: Double) {
        next("advanceClock", mapOf("seconds" to JsonPrimitive(seconds)))
    }

    override fun drainEvents() = (next("drainEvents", emptyMap()).getValue("events") as JsonArray).map { it as JsonObject }

    override fun drainEngineCalls() =
        (next("drainEngineCalls", emptyMap()).getValue("calls") as JsonArray).map { it as JsonObject }

    override fun route(uri: String): RouteResult {
        val result = next("route", mapOf("uri" to JsonPrimitive(uri))).getValue("result") as JsonObject
        val served = result["served"] as? JsonObject ?: return RouteResult.Failed(result["failed"].stringOrNull()!!)
        val hex = served["hex"].stringOrNull()!!
        return RouteResult.Served(
            ByteArray(hex.length / 2) { hex.substring(it * 2, it * 2 + 2).toInt(16).toByte() },
            served["contentType"].stringOrNull()!!,
        )
    }
}

/** Every scenario, replayed against the reference side's transcript. */
@RunWith(Parameterized::class)
class TranscriptTest(private val file: ScenarioRunner.ScenarioFile) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun scenarios(): List<ScenarioRunner.ScenarioFile> = ScenarioRunner.loadScenarios()
    }

    @Test
    fun `replays the reference transcript`() {
        val transcript = ScenarioRunner.conformanceDirectory.resolve("selftest/transcripts/${file.file}")
        val ops = (Json.parseToJsonElement(transcript.readText()) as JsonObject).getValue("ops") as JsonArray
        val harness = TranscriptHarness(ops)
        ScenarioRunner.run(file.scenario, harness)
        assertTrue("${file.file}: the TypeScript runner went further through the transcript", harness.finished)
    }
}
