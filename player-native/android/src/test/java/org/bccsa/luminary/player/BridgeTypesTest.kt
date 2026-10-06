package org.bccsa.luminary.player

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.fail
import org.junit.Test

class BridgeTypesTest {
    private fun load(maxReloadAttempts: JsonPrimitive) = buildJsonObject {
        put("playerId", "player-1")
        put("loadId", "load1")
        put("generation", 1)
        put("masterUri", "luminary://asset/1/1.m3u8")
        put("assets", buildJsonArray { })
        put("recovery", buildJsonObject {
            put("escalationWindowMs", 10000)
            put("maxReloadAttempts", maxReloadAttempts)
            put("reloadDelaysMs", buildJsonArray { })
        })
    }

    private fun warm(warmBytes: JsonPrimitive) = buildJsonObject {
        put("playerId", "player-1")
        put("loadId", "load1")
        put("schedules", buildJsonArray { })
        put("leadSeconds", 60)
        put("warmBytes", warmBytes)
    }

    private fun assertInvalid(method: String, args: JsonObject) {
        try {
            BridgeCall.decode(method, args)
            fail("$method accepted $args")
        } catch (rejection: BridgeRejection) {
            assertEquals(BridgeErrorCode.INVALID_ARGUMENT, rejection.code)
        }
    }

    @Test
    fun `a reload count or a byte count past what fits, or not a whole number, is refused`() {
        for (bad in listOf(1e300, 9.3e18, 2147483648.0, -1.0, 1.5)) {
            assertInvalid("load", load(JsonPrimitive(bad)))
            assertInvalid("warmChunks", warm(JsonPrimitive(bad)))
        }
    }

    @Test
    fun `counts that fit decode as they are`() {
        val load = BridgeCall.decode("load", load(JsonPrimitive(3))) as BridgeCall.Load
        assertEquals(3, load.args.recovery.maxReloadAttempts)
        val warm = BridgeCall.decode("warmChunks", warm(JsonPrimitive(65536))) as BridgeCall.WarmChunks
        assertEquals(65536, warm.warmBytes)
    }
}
