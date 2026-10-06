package org.bccsa.luminary.player.engine

import androidx.activity.ComponentActivity
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import java.net.InetAddress
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import org.bccsa.luminary.player.BridgeCapabilities
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.FixtureUpstream
import org.bccsa.luminary.player.HttpUpstream
import org.bccsa.luminary.player.PlayerRegistry
import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** Playback going to a TV and coming home, with the TV's player and the Cast SDK replaced by stand-ins. */
@RunWith(RobolectricTestRunner::class)
class ExoEngineCastHandoffTest {
    private class FakeCast : CastSupport {
        var listener: CastSupport.Listener? = null

        override fun start(listener: CastSupport.Listener) {
            this.listener = listener
        }

        override fun showPicker() {}

        override fun stop() {}
    }

    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val upstream = FixtureUpstream("encrypted-byterange")
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private val receiver = FakeReceiver()
    private val cast = FakeCast()
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private var address: InetAddress? = InetAddress.getByName("127.0.0.1")
    private val http = OkHttpClient()
    private val registry = PlayerRegistry(
        BridgeCapabilities(airPlay = true),
        VirtualClock(),
        HttpUpstream(OkHttpClient()),
        EngineFactory { router, clock, options ->
            ExoEngine(activity, router, clock, options, FullscreenPresenter { activity }, player, cast = cast, castAddress = { address })
        },
    ) { name, payload -> events += name to payload }

    private val playerId = registry.call("create", buildJsonObject {
        put("protocolVersion", 1)
        put("skipBackSeconds", 10)
        put("skipForwardSeconds", 10)
    }).jsonObject.getValue("playerId").jsonPrimitive.content

    @After
    fun tearDown() {
        registry.call("reset", JsonObject(emptyMap()))
        upstream.close()
    }

    private fun call(method: String, vararg args: Pair<String, Any>) = registry.call(method, buildJsonObject {
        put("playerId", playerId)
        for ((key, value) in args) {
            when (value) {
                is String -> put(key, value)
                is Number -> put(key, value)
            }
        }
    })

    private fun load(loadId: String = "load1", generation: Int = 1) {
        registry.call("load", buildJsonObject {
            put("playerId", playerId)
            put("loadId", loadId)
            put("generation", generation)
            put("masterUri", "luminary://asset/$generation/3.m3u8")
            put("assets", buildJsonArray {
                add(asset("luminary://asset/$generation/1.m3u8", upstream.text("video.m3u8")))
                add(asset("luminary://asset/$generation/2.m3u8", upstream.text("audio.m3u8")))
                add(asset("luminary://asset/$generation/3.m3u8", MASTER.replace("asset/1/", "asset/$generation/")))
            })
            put("keyHex", "000102030405060708090a0b0c0d0e0f")
            put("recovery", buildJsonObject {
                put("escalationWindowMs", 10000)
                put("maxReloadAttempts", 3)
                put("reloadDelaysMs", JsonArray(listOf(JsonPrimitive(2000))))
            })
        })
    }

    private fun fetch(url: String): Pair<Int, String> =
        http.newCall(Request.Builder().url(url).build()).execute().use { it.code to it.body!!.string() }

    private fun named(name: String) = events.filter { it.first == name }.map { it.second }

    @Test
    fun `a session that comes up with a source playing moves it to the TV, from where it was`() {
        load()
        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)

        cast.listener!!.sessionAvailable(receiver)

        val url = receiver.uri!!
        assertTrue("the TV is given the phone's server, not luminary://: $url", url.startsWith("http://127.0.0.1:") && url.endsWith("/a/1/3.m3u8"))
        assertFalse("the phone is quiet", player.playWhenReady)
        // The TV can read what it is given: the master, with every address now the server's.
        val (code, master) = fetch(url)
        assertEquals(200, code)
        assertFalse(master.contains("luminary://"))
        assertTrue(master.contains(url.substringBefore("/a/1/3.m3u8") + "/a/1/1.m3u8"))
        // And the key a playlist names, from the same place.
        val media = fetch(url.replace("/a/1/3.m3u8", "/a/1/1.m3u8")).second
        val keyUrl = Regex("URI=\"([^\"]+/key)\"").find(media)!!.groupValues[1]
        assertEquals(200, fetch(keyUrl).first)
    }

    @Test
    fun `the page's play, pause and seek reach the TV while it has playback`() {
        load()
        cast.listener!!.sessionAvailable(receiver)
        receiver.reach(5_000, playing = false)

        call("play")
        assertTrue(receiver.playWhenReady)
        call("pause")
        assertFalse(receiver.playWhenReady)
        call("seek", "position" to 30.0)
        assertEquals(30_000L, receiver.currentPosition)
        assertFalse("never the phone", player.playWhenReady)
    }

    @Test
    fun `a session that is up before there is a source takes the first one`() {
        cast.listener!!.sessionAvailable(receiver)
        assertNull(receiver.uri)

        load()

        assertNotNull(receiver.uri)
        assertFalse(player.playWhenReady)
    }

    @Test
    fun `a new source while casting replaces what is on the TV, and keeps casting`() {
        load()
        cast.listener!!.sessionAvailable(receiver)
        val first = receiver.uri!!

        load("load2", generation = 2)

        assertTrue(receiver.uri!!.endsWith("/a/2/3.m3u8"))
        assertEquals("the same server", first.substringBefore("/a/"), receiver.uri!!.substringBefore("/a/"))
        assertEquals(200, fetch(receiver.uri!!).first)
    }

    @Test
    fun `when the session ends the phone takes over where the TV had got to, and the server stops`() {
        load()
        cast.listener!!.sessionAvailable(receiver)
        receiver.reach(12_000, playing = true)
        val url = receiver.uri!!

        cast.listener!!.sessionLost()

        assertEquals(12_000L, player.currentPosition)
        assertTrue("it was playing, so it still is", player.playWhenReady)
        assertEquals(1, receiver.stops)
        val gone = try {
            fetch(url)
            false
        } catch (refused: java.io.IOException) {
            true
        }
        assertTrue("the server stopped with the cast", gone)
    }

    @Test
    fun `a TV that gives up sends playback home instead of ending it`() {
        load()
        cast.listener!!.sessionAvailable(receiver)
        receiver.reach(9_000, playing = true)

        receiver.fail()

        assertEquals(9_000L, player.currentPosition)
        assertTrue(player.playWhenReady)
        assertTrue(named("error").isEmpty())
    }

    @Test
    fun `full-screen is not opened while the TV has the picture`() {
        load()
        cast.listener!!.sessionAvailable(receiver)

        call("enterFullscreen")

        assertTrue(named("presentationchange").isEmpty())
    }

    @Test
    fun `no Wi-Fi address means no cast, and the phone carries on`() {
        address = null
        load()
        call("play")

        cast.listener!!.sessionAvailable(receiver)

        assertNull(receiver.uri)
        assertTrue(player.playWhenReady)
    }

    @Test
    fun `the phone's own pause at the handoff is not told to the page as the viewer pausing`() {
        load()
        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
        events.clear()

        cast.listener!!.sessionAvailable(receiver)

        assertTrue("no pause event from the phone going quiet", named("pause").isEmpty())
    }

    private companion object {
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
