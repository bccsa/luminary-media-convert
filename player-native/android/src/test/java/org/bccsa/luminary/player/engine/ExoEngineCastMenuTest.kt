package org.bccsa.luminary.player.engine

import androidx.activity.ComponentActivity
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import java.net.InetAddress
import kotlinx.serialization.json.Json
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
import org.bccsa.luminary.player.BridgeErrorCode
import org.bccsa.luminary.player.BridgeRejection
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.FixtureUpstream
import org.bccsa.luminary.player.HttpUpstream
import org.bccsa.luminary.player.PlayerRegistry
import org.bccsa.luminary.player.conformance.VirtualClock
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** Our own receiver's menu: what the phone tells the TV, and what the TV's picks become. */
@RunWith(RobolectricTestRunner::class)
class ExoEngineCastMenuTest {
    private class FakeCast : CastSupport {
        var listener: CastSupport.Listener? = null
        val sent = mutableListOf<JsonObject>()

        override fun start(listener: CastSupport.Listener) {
            this.listener = listener
        }

        override fun showPicker() {}

        override fun send(text: String) {
            sent += Json.parseToJsonElement(text).jsonObject
        }

        override fun stop() {}
    }

    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val upstream = FixtureUpstream("encrypted-byterange")
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private val receiver = FakeReceiver()
    private val cast = FakeCast()
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private val http = OkHttpClient()

    private fun registry(capabilities: BridgeCapabilities) = PlayerRegistry(
        capabilities,
        VirtualClock(),
        HttpUpstream(OkHttpClient()),
        EngineFactory { router, clock, options ->
            ExoEngine(
                activity, router, clock, options, FullscreenPresenter { activity }, player,
                cast = cast, castAddress = { InetAddress.getByName("127.0.0.1") },
            )
        },
    ) { name, payload -> events += name to payload }

    private val registry = registry(BridgeCapabilities(variantSwitching = true, airPlay = true, castMenu = true))
    private val playerId = create(registry)

    private fun create(registry: PlayerRegistry) = registry.call("create", buildJsonObject {
        put("protocolVersion", 1)
        put("skipBackSeconds", 10)
        put("skipForwardSeconds", 10)
    }).jsonObject.getValue("playerId").jsonPrimitive.content

    @After
    fun tearDown() {
        registry.call("reset", JsonObject(emptyMap()))
        upstream.close()
    }

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
    }

    private fun setMenu(registry: PlayerRegistry = this.registry, playerId: String = this.playerId, activeQualityId: String = "auto") =
        registry.call("setCastMenu", buildJsonObject {
            put("playerId", playerId)
            put("menu", buildJsonObject {
                put("angles", buildJsonArray {
                    add(buildJsonObject { put("id", "cam1"); put("label", "Stage") })
                    add(buildJsonObject { put("id", "__audio__"); put("label", "Audio only") })
                })
                put("activeAngleId", "cam1")
                put("qualities", buildJsonArray { add(buildJsonObject { put("id", "90"); put("label", "90p") }) })
                put("activeQualityId", activeQualityId)
            })
        })

    private fun named(name: String) = events.filter { it.first == name }.map { it.second }

    private fun fetch(url: String): String = http.newCall(Request.Builder().url(url).build()).execute().use { it.body!!.string() }

    @Test
    fun `the menu waits for a session, and goes to the TV when one comes up and on every change`() {
        load()
        setMenu()
        assertTrue("nothing to send it to yet", cast.sent.isEmpty())

        cast.listener!!.sessionAvailable(receiver)
        assertEquals(1, cast.sent.size)
        val menu = cast.sent.last()
        assertEquals("menu", menu.getValue("type").jsonPrimitive.content)
        assertEquals("Stage", (menu.getValue("angles") as JsonArray)[0].jsonObject.getValue("label").jsonPrimitive.content)
        assertEquals("cam1", menu.getValue("activeAngleId").jsonPrimitive.content)
        assertEquals("auto", menu.getValue("activeQualityId").jsonPrimitive.content)

        setMenu(activeQualityId = "90")
        assertEquals("90", cast.sent.last().getValue("activeQualityId").jsonPrimitive.content)

        // A receiver that has just loaded asks for it again.
        cast.listener!!.message("""{"type":"ready"}""")
        assertEquals(3, cast.sent.size)
    }

    @Test
    fun `an angle or a quality picked on the TV reaches the page as castselect, and nothing else does`() {
        load()
        cast.listener!!.sessionAvailable(receiver)

        cast.listener!!.message("""{"type":"select","kind":"angle","id":"__audio__"}""")
        cast.listener!!.message("""{"type":"select","kind":"quality","id":"90"}""")
        cast.listener!!.message("""{"type":"select","kind":"volume","id":"11"}""")
        cast.listener!!.message("""{"type":"select","kind":"angle"}""")
        cast.listener!!.message("not json")

        val picks = named("castselect").map { it.getValue("kind").jsonPrimitive.content to it.getValue("id").jsonPrimitive.content }
        assertEquals(listOf("angle" to "__audio__", "quality" to "90"), picks)
        assertEquals("load1", named("castselect").first().getValue("loadId").jsonPrimitive.content)
    }

    @Test
    fun `a quality pinned while casting gives the TV a master with only that rendition, at the same place`() {
        load()
        cast.listener!!.sessionAvailable(receiver)
        receiver.seekTo(30_000)

        registry.call("setVariant", buildJsonObject { put("playerId", playerId); put("id", "90_300000") })
        val pinned = receiver.uri!!
        assertTrue(pinned, pinned.endsWith("/a/1/3.m3u8?v=90_300000"))
        assertEquals(30_000, receiver.currentPosition)
        val master = fetch(pinned)
        assertTrue(master.contains("BANDWIDTH=300000"))
        assertFalse("the other rendition is gone", master.contains("BANDWIDTH=900000"))

        registry.call("setVariant", buildJsonObject { put("playerId", playerId); put("id", "auto") })
        assertTrue(receiver.uri!!.endsWith("/a/1/3.m3u8"))
        assertTrue(fetch(receiver.uri!!).contains("BANDWIDTH=900000"))
    }

    @Test
    fun `setCastMenu is refused as unsupported without castMenu, and a malformed menu as invalid`() {
        val plain = registry(BridgeCapabilities(airPlay = true))
        val other = create(plain)
        try {
            setMenu(plain, other)
            fail("unsupported")
        } catch (rejection: BridgeRejection) {
            assertEquals(BridgeErrorCode.UNSUPPORTED, rejection.code)
        } finally {
            plain.call("reset", JsonObject(emptyMap()))
        }

        try {
            registry.call("setCastMenu", buildJsonObject {
                put("playerId", playerId)
                put("menu", buildJsonObject {
                    put("angles", buildJsonArray { add(buildJsonObject { put("id", "cam1") }) })
                    put("qualities", JsonArray(emptyList()))
                    put("activeQualityId", "auto")
                })
            })
            fail("invalid")
        } catch (rejection: BridgeRejection) {
            assertEquals(BridgeErrorCode.INVALID_ARGUMENT, rejection.code)
        }
    }

    private companion object {
        fun asset(uri: String, text: String) = buildJsonObject {
            put("uri", uri)
            put("contentType", "application/vnd.apple.mpegurl")
            put("text", text)
        }

        val MASTER = """
            #EXTM3U
            #EXT-X-VERSION:7
            #EXT-X-INDEPENDENT-SEGMENTS
            #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="luminary://asset/1/2.m3u8"
            #EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=320x180,AUDIO="aud"
            luminary://asset/1/1.m3u8
            #EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90,AUDIO="aud"
            luminary://asset/1/1.m3u8
        """.trimIndent() + "\n"
    }
}
