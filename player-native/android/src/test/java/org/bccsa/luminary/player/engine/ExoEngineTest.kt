package org.bccsa.luminary.player.engine

import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.bccsa.luminary.player.BridgeCapabilities
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.FixtureUpstream
import org.bccsa.luminary.player.HttpUpstream
import org.bccsa.luminary.player.KEY_URI
import org.bccsa.luminary.player.PlayerRegistry
import org.bccsa.luminary.player.UriRouter
import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * A real ExoPlayer, on Media3's test renderers, playing the encrypted byte-range fixture served
 * entirely through the bridge: the playlists and key from memory, segments from a fake upstream.
 */
@RunWith(RobolectricTestRunner::class)
class ExoEngineTest {
    private val context = RuntimeEnvironment.getApplication()
    private val upstream = FixtureUpstream("encrypted-byterange")
    private val player: ExoPlayer = TestExoPlayerBuilder(context).build()
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private var lastRouter: UriRouter? = null
    private val registry = PlayerRegistry(
        BridgeCapabilities(variantSwitching = true),
        VirtualClock(),
        HttpUpstream(OkHttpClient()),
        EngineFactory { router, clock, options ->
            lastRouter = router
            ExoEngine(context, router, clock, options, FullscreenPresenter { null }, player)
        },
    ) { name, payload -> events += name to payload }

    private val playerId = registry.call("create", buildJsonObject {
        put("protocolVersion", 1)
        put("skipBackSeconds", 10)
        put("skipForwardSeconds", 10)
    }).jsonObject.getValue("playerId").jsonPrimitive.content

    private val router: UriRouter get() = lastRouter!!

    @After
    fun tearDown() {
        registry.call("reset", JsonObject(emptyMap()))
        upstream.close()
    }

    private fun load(loadId: String, keyHex: String?) {
        registry.call("load", buildJsonObject {
            put("playerId", playerId)
            put("loadId", loadId)
            put("generation", 1)
            put("masterUri", "luminary://asset/1/3.m3u8")
            put("assets", buildJsonArray {
                add(asset("luminary://asset/1/1.m3u8", upstream.text("video.m3u8")))
                add(asset("luminary://asset/1/2.m3u8", upstream.text("audio.m3u8")))
                add(asset("luminary://asset/1/3.m3u8", MASTER))
            })
            if (keyHex != null) put("keyHex", keyHex)
            put("recovery", buildJsonObject {
                put("escalationWindowMs", 10000)
                put("maxReloadAttempts", 3)
                put("reloadDelaysMs", buildJsonArray { add(JsonPrimitive(2000)) })
            })
        })
    }

    private fun call(method: String, vararg args: Pair<String, Any>) = registry.call(method, buildJsonObject {
        put("playerId", playerId)
        for ((key, value) in args) {
            when (value) {
                is String -> put(key, value)
                is Number -> put(key, value)
                is Boolean -> put(key, value)
            }
        }
    })

    private fun named(name: String) = events.filter { it.first == name }.map { it.second }

    @Test
    fun `plays an encrypted byte-range fMP4 stream to the end`() {
        load("load1", KEY_HEX)
        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)

        val names = events.map { it.first }
        assertEquals("audiotracks-updated", names.first())
        assertEquals(JsonArray(emptyList()), events.first().second["tracks"])
        assertTrue(names.containsAll(listOf("durationchange", "loadedmetadata", "playing", "ended")))
        assertTrue(events.all { it.second["loadId"] == JsonPrimitive("load1") && it.second["playerId"] == JsonPrimitive(playerId) })

        assertEquals(2.0, named("loadedmetadata").single().getValue("duration").jsonPrimitive.double, 0.05)

        val tracks = named("audiotracks-updated").last()
        assertEquals("en", tracks.getValue("tracks").jsonArray.single().jsonObject.getValue("lang").jsonPrimitive.content)
        assertEquals(tracks.getValue("tracks").jsonArray.single().jsonObject["id"], tracks["activeId"])

        val variant = named("variants-updated").last().getValue("variants").jsonArray.single().jsonObject
        assertEquals("90_300000", variant.getValue("id").jsonPrimitive.content)

        // Only segments and inits reach the network; every segment is a byte range of a chunk.
        val paths = upstream.requests.map { it.path!! }
        assertTrue(paths.none { it.endsWith(".m3u8") })
        assertTrue(upstream.requests.filter { it.path!!.startsWith("/media/") }.all { it.getHeader("Range") != null })
    }

    @Test
    fun `without the key the load fails, and says so`() {
        load("load1", keyHex = null)
        call("play")
        TestPlayerRunHelper.advance(player).untilPlayerError()

        val error = named("error").single()
        assertEquals(JsonPrimitive(true), error["fatal"])
    }

    @Test
    fun `reattach starts the track list over under the new load, and keeps the position`() {
        load("load1", KEY_HEX)
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
        call("seek", "position" to 1.0, "exact" to true)
        TestPlayerRunHelper.advance(player).untilPendingCommandsAreFullyHandled()
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
        assertTrue(named("seeked").isNotEmpty())
        events.clear()

        call("reattach", "loadId" to "load2")
        assertEquals("audiotracks-updated" to JsonArray(emptyList()), events.first().first to events.first().second["tracks"])
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)

        assertTrue(events.all { it.second["loadId"] == JsonPrimitive("load2") })
        assertEquals(1, named("audiotracks-updated").last().getValue("tracks").jsonArray.size)
        assertEquals(1000, player.currentPosition)
    }

    @Test
    fun `destroy zeroes the key, and nothing is emitted after it`() {
        load("load1", KEY_HEX)
        val router = router
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)

        call("destroy")
        val emitted = events.size
        assertEquals(org.bccsa.luminary.player.UriRouter.Route.Failed("key-required"), router.route(KEY_URI))
        assertEquals(emitted, events.size)
    }

    private companion object {
        const val KEY_HEX = "000102030405060708090a0b0c0d0e0f"

        val MASTER = """
            #EXTM3U
            #EXT-X-VERSION:7
            #EXT-X-INDEPENDENT-SEGMENTS
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="luminary://asset/1/2.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,AUDIO="aud"
            luminary://asset/1/1.m3u8
        """.trimIndent() + "\n"

        fun asset(uri: String, text: String) = buildJsonObject {
            put("uri", uri)
            put("contentType", "application/vnd.apple.mpegurl")
            put("text", text)
        }
    }
}
