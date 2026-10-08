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

    private fun boundary(vararg fields: Pair<String, kotlinx.serialization.json.JsonElement>) = buildJsonObject {
        for ((key, value) in fields) put(key, value)
    }

    private fun warm(boundary: JsonObject) = buildJsonObject {
        put("playerId", "player-1")
        put("loadId", "load1")
        put("schedules", buildJsonArray { add(buildJsonArray { add(boundary) }) })
        put("leadSeconds", 60)
        put("warmBytes", 1024)
    }

    @Test
    fun `a warming schedule with an incomplete boundary is refused, not thinned out`() {
        val ok = boundary("url" to JsonPrimitive("u"), "start" to JsonPrimitive(0), "end" to JsonPrimitive(20))
        BridgeCall.decode("warmChunks", warm(ok))
        assertInvalid("warmChunks", warm(boundary("url" to JsonPrimitive("u"), "start" to JsonPrimitive(0))))
        assertInvalid("warmChunks", warm(boundary("url" to JsonPrimitive(5), "start" to JsonPrimitive(0), "end" to JsonPrimitive(20))))
        assertInvalid("warmChunks", warm(boundary("url" to JsonPrimitive("u"), "start" to JsonPrimitive("0"), "end" to JsonPrimitive(20))))
    }

    @Test
    fun `a key is 32 ASCII hex characters, and hex that does not decode is no key`() {
        val fullwidth = "Ａ".repeat(32)
        val args = load(JsonPrimitive(3)).let { JsonObject(it + ("keyHex" to JsonPrimitive(fullwidth))) }
        assertInvalid("load", args)

        val holder = KeyHolder()
        holder.set("00112233445566778899aabbccddeeff")
        assertEquals(16, holder.copy()!!.size)
        holder.set(fullwidth)
        assertEquals(null, holder.copy())
        holder.set("abc")
        assertEquals(null, holder.copy())
    }

    private fun loadWith(bandwidth: kotlinx.serialization.json.JsonElement?) = JsonObject(
        load(JsonPrimitive(3)) + (if (bandwidth != null) mapOf("bandwidthEstimate" to bandwidth) else emptyMap()),
    )

    @Test
    fun `a bandwidth estimate is a hint, a usable number is kept and anything else is no hint`() {
        fun estimate(value: kotlinx.serialization.json.JsonElement?) =
            (BridgeCall.decode("load", loadWith(value)) as BridgeCall.Load).args.bandwidthEstimate

        assertEquals(null, estimate(null))
        assertEquals(5_000_000.0, estimate(JsonPrimitive(5_000_000))!!, 0.0)
        assertEquals(null, estimate(JsonPrimitive(0)))
        assertEquals(null, estimate(JsonPrimitive(-5)))
    }

    @Test
    fun `a bandwidth estimate that is not a number is refused`() {
        assertInvalid("load", loadWith(JsonPrimitive("fast")))
    }

    @Test
    fun `counts that fit decode as they are`() {
        val load = BridgeCall.decode("load", load(JsonPrimitive(3))) as BridgeCall.Load
        assertEquals(3, load.args.recovery.maxReloadAttempts)
        val warm = BridgeCall.decode("warmChunks", warm(JsonPrimitive(65536))) as BridgeCall.WarmChunks
        assertEquals(65536, warm.warmBytes)
    }
}
