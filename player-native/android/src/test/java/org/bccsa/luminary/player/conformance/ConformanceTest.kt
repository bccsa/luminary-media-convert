package org.bccsa.luminary.player.conformance

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

/**
 * One test per scenario file, against plan 02's harness. Without a harness every scenario
 * fails rather than skips: the platform does not conform until it runs them.
 */
@RunWith(Parameterized::class)
class ConformanceTest(private val file: ScenarioRunner.ScenarioFile) {
    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun scenarios(): List<ScenarioRunner.ScenarioFile> = ScenarioRunner.loadScenarios()
    }

    @Test
    fun scenario() {
        val harness = makeConformanceHarness()
            ?: throw MatchError("No ConformanceHarness: build plan 02's phase 1a (PlayerRegistry on a FakeEngine)")
        ScenarioRunner.run(file.scenario, harness)
    }
}

class ConformanceFormatTest {
    @Test
    fun `the shared scenario files load and validate`() {
        assertTrue(ScenarioRunner.loadScenarios().isNotEmpty())
    }

    @Test
    fun `refs and matchers pass the shared cases`() {
        val file = ScenarioRunner.conformanceDirectory.resolve("selftest/match-cases.json")
        val cases = (Json.parseToJsonElement(file.readText()) as JsonObject).getValue("cases") as JsonArray
        for (case in cases) {
            case as JsonObject
            val name = case["name"].stringOrNull()
            val refs = Refs()
            for (op in case.getValue("ops") as JsonArray) {
                op as JsonObject
                val assert = op["assert"] as? JsonObject
                if (assert != null) {
                    val ok = jsonEquals(op["ok"], JsonPrimitive(true))
                    try {
                        refs.assert(assert["actual"], assert.getValue("expected"))
                        if (!ok) fail("$name: matched, expected a mismatch")
                    } catch (error: MatchError) {
                        if (ok) fail("$name: ${error.message}")
                    }
                } else if (jsonEquals(op["error"], JsonPrimitive(true))) {
                    try {
                        refs.issue(op.getValue("issue"))
                        fail("$name: issued, expected an error")
                    } catch (_: MatchError) {
                    }
                } else {
                    val issued = refs.issue(op.getValue("issue"))
                    assertTrue("$name: issued $issued", jsonEquals(issued, op["result"]))
                }
            }
        }
        assertEquals(true, cases.isNotEmpty())
    }
}
