package org.bccsa.luminary.player.engine

import androidx.activity.ComponentActivity
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.bccsa.luminary.player.BridgeCapabilities
import org.bccsa.luminary.player.BridgeErrorCode
import org.bccsa.luminary.player.BridgeRejection
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.HttpUpstream
import org.bccsa.luminary.player.PlayerRegistry
import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** What the engine does with Cast, with the Cast SDK replaced by a fake: devices, the picker, shutdown. */
@RunWith(RobolectricTestRunner::class)
class ExoEngineCastTest {
    private class FakeCast : CastSupport {
        var listener: CastSupport.Listener? = null
        var pickers = 0
        var stops = 0

        override fun start(listener: CastSupport.Listener) {
            this.listener = listener
        }

        override fun showPicker() {
            pickers++
        }

        override fun stop() {
            stops++
        }
    }

    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private val cast = FakeCast()
    private val events = mutableListOf<Pair<String, JsonObject>>()

    private fun registry(capabilities: BridgeCapabilities) = PlayerRegistry(
        capabilities,
        VirtualClock(),
        HttpUpstream(OkHttpClient()),
        EngineFactory { router, clock, options ->
            ExoEngine(activity, router, clock, options, FullscreenPresenter { activity }, player, cast = cast)
        },
    ) { name, payload -> events += name to payload }

    private val registry = registry(BridgeCapabilities(airPlay = true))
    private val playerId = registry.call("create", buildJsonObject {
        put("protocolVersion", 1)
        put("skipBackSeconds", 10)
        put("skipForwardSeconds", 10)
    }).jsonObject.getValue("playerId").jsonPrimitive.content

    @After
    fun tearDown() {
        registry.call("reset", JsonObject(emptyMap()))
    }

    private fun changes() = events.filter { it.first == "airplaychange" }.map { it.second }

    private fun load(loadId: String) {
        registry.call("load", buildJsonObject {
            put("playerId", playerId)
            put("loadId", loadId)
            put("generation", 1)
            put("masterUri", "luminary://asset/1/1.m3u8")
            put("assets", buildJsonArray {
                add(buildJsonObject {
                    put("uri", "luminary://asset/1/1.m3u8")
                    put("contentType", "application/vnd.apple.mpegurl")
                    put("text", "#EXTM3U\n")
                })
            })
            put("recovery", buildJsonObject {
                put("escalationWindowMs", 10000)
                put("maxReloadAttempts", 3)
                put("reloadDelaysMs", JsonArray(listOf(JsonPrimitive(2000))))
            })
        })
    }

    @Test
    fun `devices coming and going are told to the page as they happen, even before a source is loaded`() {
        cast.listener!!.routesChanged(available = true, active = false)

        val first = changes().single()
        assertEquals(JsonPrimitive(true), first["available"])
        assertEquals(JsonPrimitive(false), first["active"])
        assertEquals(JsonPrimitive(playerId), first["playerId"])
        assertNull("no load to stamp it with yet", first["loadId"])
    }

    @Test
    fun `a change after a load is stamped with that load, and a repeat is not told twice`() {
        load("load1")
        cast.listener!!.routesChanged(true, false)
        cast.listener!!.routesChanged(true, false)
        cast.listener!!.routesChanged(true, true)

        val told = changes()
        assertEquals(2, told.size)
        assertEquals(JsonPrimitive("load1"), told[0]["loadId"])
        assertEquals(JsonPrimitive(true), told[1]["active"])
    }

    @Test
    fun `the page asking for the picker opens the system's list`() {
        registry.call("showAirPlayPicker", buildJsonObject { put("playerId", playerId) })
        assertEquals(1, cast.pickers)
    }

    @Test
    fun `destroying the player stops watching for devices`() {
        registry.call("destroy", buildJsonObject { put("playerId", playerId) })
        assertEquals(1, cast.stops)
    }

    @Test
    fun `without the capability the picker is refused and nothing is asked of the SDK`() {
        val without = registry(BridgeCapabilities())
        val id = without.call("create", buildJsonObject {
            put("protocolVersion", 1)
            put("skipBackSeconds", 10)
            put("skipForwardSeconds", 10)
        }).jsonObject.getValue("playerId").jsonPrimitive.content
        val before = cast.pickers
        try {
            without.call("showAirPlayPicker", buildJsonObject { put("playerId", id) })
            fail("accepted")
        } catch (rejection: BridgeRejection) {
            assertEquals(BridgeErrorCode.UNSUPPORTED, rejection.code)
        } finally {
            // A player left alive would keep its media session, which LeakTest counts.
            without.call("reset", JsonObject(emptyMap()))
        }
        assertEquals(before, cast.pickers)
    }

    @Test
    fun `a Cast SDK that fails never stops the player from existing or being used`() {
        val broken = object : CastSupport {
            override fun start(listener: CastSupport.Listener) = throw IllegalStateException("OptionsProvider is not in the manifest")

            override fun showPicker() = throw IllegalStateException("no")

            override fun stop() = throw IllegalStateException("no")
        }
        val failing = PlayerRegistry(
            BridgeCapabilities(airPlay = true),
            VirtualClock(),
            HttpUpstream(OkHttpClient()),
            EngineFactory { router, clock, options ->
                ExoEngine(activity, router, clock, options, FullscreenPresenter { activity }, TestExoPlayerBuilder(activity).build(), cast = broken)
            },
        ) { _, _ -> }
        try {
            val id = failing.call("create", buildJsonObject {
                put("protocolVersion", 1)
                put("skipBackSeconds", 10)
                put("skipForwardSeconds", 10)
            }).jsonObject.getValue("playerId").jsonPrimitive.content
            failing.call("showAirPlayPicker", buildJsonObject { put("playerId", id) })
        } finally {
            failing.call("reset", JsonObject(emptyMap()))
        }
    }

    @Test
    fun `a host that has not opted in has no cast support, here or on a device without Play services`() {
        assertFalse(GoogleCastSupport.supported(activity))
    }
}
