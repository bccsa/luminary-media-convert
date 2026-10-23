package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** A harness that answers from a script, for pinning the runner itself: a runner that passes everything proves nothing. */
private class ScriptedHarness : ConformanceHarness {
    val events = mutableListOf<JsonObject>()
    val answers = mutableMapOf<String, CallResult>()
    val signals = mutableListOf<String>()

    override fun start(capabilities: JsonObject) {}
    override fun call(method: String, args: JsonObject) = answers[method] ?: CallResult.Resolved(JsonObject(emptyMap()))
    override fun engine(signal: String, args: JsonObject) { signals += signal }
    override fun advanceClock(seconds: Double) {}
    override fun drainEvents() = events.toList().also { events.clear() }
    override fun drainEngineCalls() = emptyList<JsonObject>()
    override fun route(uri: String): RouteResult = RouteResult.Failed("not-found")
}

private fun json(text: String) = Json.parseToJsonElement(text) as JsonObject

private fun scenario(steps: String) = json("""{ "name": "self-test", "steps": $steps }""")

private const val CREATE = """{ "call": { "method": "create", "result": { "playerId": "${'$'}player" } } }"""

class RunnerSelfTest {
    @Test
    fun `passes a conversation that matches`() {
        val harness = ScriptedHarness()
        harness.answers["create"] = CallResult.Resolved(json("""{ "playerId": "p-1" }"""))
        harness.events += json("""{ "name": "playing", "payload": { "playerId": "p-1", "loadId": "l" } }""")
        ScenarioRunner.run(
            scenario(
                """[
                    $CREATE,
                    { "event": { "name": "playing", "payload": { "playerId": "${'$'}player" } } },
                    { "engine": { "signal": "playing" } },
                    { "drive": { "start": {} }, "note": "TS only: skipped" }
                ]""",
            ),
            harness,
        )
        assertEquals(listOf("playing"), harness.signals)
    }

    @Test
    fun `fails on an event left unasserted`() {
        val harness = ScriptedHarness()
        harness.events += json("""{ "name": "pause", "payload": {} }""")
        assertThrows(MatchError::class.java) {
            ScenarioRunner.run(scenario("""[{ "advanceClock": 1 }]"""), harness)
        }
    }

    @Test
    fun `fails on a payload stamped with another player`() {
        val harness = ScriptedHarness()
        harness.answers["create"] = CallResult.Resolved(json("""{ "playerId": "p-1" }"""))
        harness.events += json("""{ "name": "playing", "payload": { "playerId": "p-2" } }""")
        assertThrows(MatchError::class.java) {
            ScenarioRunner.run(
                scenario("""[$CREATE, { "event": { "name": "playing", "payload": { "playerId": "${'$'}player" } } }]"""),
                harness,
            )
        }
    }

    @Test
    fun `fails when a call resolves that should reject`() {
        assertThrows(MatchError::class.java) {
            ScenarioRunner.run(
                scenario("""[{ "call": { "method": "play", "rejects": "unknown-player" } }]"""),
                ScriptedHarness(),
            )
        }
    }

    @Test
    fun `fails on a route that answers differently`() {
        assertThrows(MatchError::class.java) {
            ScenarioRunner.run(
                scenario("""[{ "route": { "uri": "luminary://key", "expect": { "bytes": 16 } } }]"""),
                ScriptedHarness(),
            )
        }
    }
}
