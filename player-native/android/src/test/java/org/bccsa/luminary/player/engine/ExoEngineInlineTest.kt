package org.bccsa.luminary.player.engine

import android.widget.FrameLayout
import android.view.View
import androidx.activity.ComponentActivity
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
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
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.FixtureUpstream
import org.bccsa.luminary.player.HttpUpstream
import org.bccsa.luminary.player.PlayerRegistry
import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** The engine with the picture shown in the page: who holds it, and what leaving full-screen does to playback. */
@RunWith(RobolectricTestRunner::class)
class ExoEngineInlineTest {
    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val container = FrameLayout(activity)
    private val web = View(activity)
    private val upstream = FixtureUpstream("encrypted-byterange")
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private val inline = InlinePresenter({ web }, { activity })
    private val registry = PlayerRegistry(
        BridgeCapabilities(inlineVideo = true),
        VirtualClock(),
        HttpUpstream(OkHttpClient()),
        EngineFactory { router, clock, options ->
            ExoEngine(activity, router, clock, options, FullscreenPresenter { activity }, player, inline = inline)
        },
    ) { name, payload -> events += name to payload }

    private val playerId = registry.call("create", buildJsonObject {
        put("protocolVersion", 1)
        put("skipBackSeconds", 10)
        put("skipForwardSeconds", 10)
    }).jsonObject.getValue("playerId").jsonPrimitive.content

    init {
        container.addView(web, FrameLayout.LayoutParams(800, 1600))
        activity.setContentView(container)
    }

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
                is Boolean -> put(key, value)
                is JsonObject -> put(key, value)
            }
        }
    })

    private fun load() {
        registry.call("load", buildJsonObject {
            put("playerId", playerId)
            put("loadId", "load1")
            put("generation", 1)
            put("masterUri", "luminary://asset/1/3.m3u8")
            put("assets", buildJsonArray {
                add(asset("luminary://asset/1/1.m3u8", upstream.text("video.m3u8")))
                add(asset("luminary://asset/1/2.m3u8", upstream.text("audio.m3u8")))
                add(asset("luminary://asset/1/3.m3u8", MASTER))
            })
            put("keyHex", "000102030405060708090a0b0c0d0e0f")
            put("recovery", buildJsonObject {
                put("escalationWindowMs", 10000)
                put("maxReloadAttempts", 3)
                put("reloadDelaysMs", JsonArray(listOf(JsonPrimitive(2000))))
            })
        })
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
    }

    private fun frame() = buildJsonObject {
        put("x", 0)
        put("y", 72)
        put("width", 390)
        put("height", 219)
    }

    private fun states() = events.filter { it.first == "presentationchange" }.map { it.second.getValue("state").jsonPrimitive.content }

    @Test
    fun `full-screen takes the picture from the page and gives it back, and playback goes on`() {
        load()
        call("setInlineFrame", "frame" to frame())
        call("play")
        assertNotNull(inline.view!!.player)

        call("enterFullscreen")
        assertNull(inline.view!!.player)
        call("exitFullscreen")

        assertNotNull(inline.view!!.player)
        assertTrue("the picture plays on in the page", player.playWhenReady)
        assertEquals(listOf("fullscreen", "inline"), states())
    }

    @Test
    fun `without a picture in the page, leaving full-screen pauses`() {
        load()
        call("play")
        call("enterFullscreen")
        call("exitFullscreen")

        assertTrue("paused", !player.playWhenReady)
    }

    @Test
    fun `a finished item gets its last frame back with the page's picture, and ends only once`() {
        load()
        call("setInlineFrame", "frame" to frame())
        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)
        call("enterFullscreen")

        call("exitFullscreen")
        // The quiet seek takes the player through buffering and back to the end.
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)
        TestPlayerRunHelper.advance(player).untilPendingCommandsAreFullyHandled()

        assertEquals(Player.STATE_ENDED, player.playbackState)
        assertEquals("the page is told once", 1, events.count { it.first == "ended" })
        assertEquals("a quiet seek says nothing", 0, events.count { it.first == "seeked" })
    }

    @Test
    fun `entering full-screen on a finished item draws its last frame too, and does not end twice`() {
        load()
        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)

        call("enterFullscreen")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)
        TestPlayerRunHelper.advance(player).untilPendingCommandsAreFullyHandled()

        assertEquals(1, events.count { it.first == "ended" })
        assertEquals(0, events.count { it.first == "seeked" })
    }

    @Test
    fun `hiding the frame takes the view away, and the web view is as it was`() {
        load()
        call("setInlineFrame", "frame" to frame())
        assertEquals(2, container.childCount)

        call("setInlineFrame")
        assertEquals(1, container.childCount)
        assertNull(inline.view)
    }

    @Test
    fun `turning to landscape while the page shows the picture opens it full-screen`() {
        load()
        call("setInlineFrame", "frame" to frame())

        inline.onRotatedToLandscape!!.invoke()

        assertEquals(listOf("fullscreen"), states())
    }

    @Test
    fun `turning to landscape with no picture in the page opens nothing`() {
        load()
        inline.onRotatedToLandscape!!.invoke()

        assertEquals(emptyList<String>(), states())
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
