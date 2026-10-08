package org.bccsa.luminary.player.engine

import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.CommandButton
import androidx.media3.session.MediaSession
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
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
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/** Presentation on a real ExoPlayer and a real Activity: what has a view, and what the system is offered. */
@RunWith(RobolectricTestRunner::class)
class ExoEngineFullscreenTest {
    private val context = RuntimeEnvironment.getApplication()
    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val upstream = FixtureUpstream("encrypted-byterange")
    private val player: ExoPlayer = TestExoPlayerBuilder(context).build()
    private val presenter = FullscreenPresenter { activity }
    private val events = mutableListOf<Pair<String, JsonObject>>()
    private var engine: ExoEngine? = null
    private var skipBack = 10.0
    /** The app's visibility, as `ProcessLifecycleOwner` reports it; it starts in the foreground. */
    private val app = object : LifecycleOwner {
        val registry = LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.RESUMED }
        override val lifecycle: Lifecycle get() = registry
    }
    private var skipForward = 10.0

    private val registry by lazy {
        PlayerRegistry(
            BridgeCapabilities(variantSwitching = true),
            VirtualClock(),
            HttpUpstream(OkHttpClient()),
            EngineFactory { router, clock, options ->
                ExoEngine(context, router, clock, options, presenter, player, app.lifecycle).also { engine = it }
            },
        ) { name, payload -> events += name to payload }
    }
    private var playerId = ""

    @After
    fun tearDown() {
        registry.call("reset", JsonObject(emptyMap()))
        upstream.close()
    }

    private fun create() {
        playerId = registry.call("create", buildJsonObject {
            put("protocolVersion", 1)
            put("skipBackSeconds", skipBack)
            put("skipForwardSeconds", skipForward)
        }).jsonObject.getValue("playerId").jsonPrimitive.content
    }

    /** Loads [master] (a video master, or an audio-only media playlist) and waits for the item. */
    private fun load(audioOnly: Boolean, waitForReady: Boolean = true, nowPlaying: JsonObject? = null) {
        registry.call("load", buildJsonObject {
            put("playerId", playerId)
            put("loadId", "load1")
            put("generation", 1)
            put("masterUri", if (audioOnly) "luminary://asset/1/2.m3u8" else "luminary://asset/1/3.m3u8")
            put("assets", buildJsonArray {
                add(asset(1, upstream.text("video.m3u8")))
                add(asset(2, upstream.text("audio.m3u8")))
                add(asset(3, MASTER))
            })
            put("keyHex", KEY_HEX)
            put("recovery", buildJsonObject {
                put("escalationWindowMs", 10000)
                put("maxReloadAttempts", 3)
                put("reloadDelaysMs", buildJsonArray { add(JsonPrimitive(2000)) })
            })
            if (nowPlaying != null) put("nowPlaying", nowPlaying)
        })
        if (waitForReady) TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
    }

    private fun call(method: String) = registry.call(method, buildJsonObject { put("playerId", playerId) })

    private fun presentationChanges() = events.filter { it.first == "presentationchange" }.map { it.second["state"]!!.jsonPrimitive.content }

    @Test
    fun `a video item is presented with the skin's controls, and dismissed by exitFullscreen`() {
        create()
        load(audioOnly = false)

        call("enterFullscreen")

        assertTrue(presenter.isPresented)
        assertNotNull(presenter.skinControls())
        assertEquals(listOf("fullscreen"), presentationChanges())

        call("exitFullscreen")
        assertFalse(presenter.isPresented)
        assertEquals(listOf("fullscreen", "inline"), presentationChanges())
    }

    @Test
    fun `audio-only has no view`() {
        create()
        load(audioOnly = true)

        call("enterFullscreen")

        assertFalse("nothing is presented for audio", presenter.isPresented)
        assertEquals("and nothing is announced", emptyList<String>(), presentationChanges())
    }

    @Test
    fun `a view raised before the tracks are known comes down when they show no video`() {
        create()
        load(audioOnly = true, waitForReady = false)
        call("enterFullscreen")
        assertTrue("presumed to have a picture until told otherwise", presenter.isPresented)

        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)

        assertFalse(presenter.isPresented)
        assertEquals(listOf("fullscreen", "inline"), presentationChanges())
    }

    @Test
    fun `the lock screen and notification get skip buttons labelled with the snapped seconds`() {
        skipBack = 30.0
        skipForward = 7.0
        create()

        val buttons: List<CommandButton> = engine!!.mediaSession.mediaButtonPreferences
        assertEquals(listOf(Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD), buttons.map { it.playerCommand })
        assertEquals(listOf("Back 30 seconds", "Forward 5 seconds"), buttons.map { it.displayName.toString() })
        assertEquals(listOf(CommandButton.ICON_SKIP_BACK_30, CommandButton.ICON_SKIP_FORWARD_5), buttons.map { it.icon })
    }

    @Test
    fun `an engine built with no injected player skips by the snapped seconds`() {
        val engine = ExoEngine(
            context, org.bccsa.luminary.player.UriRouter(org.bccsa.luminary.player.AssetStore(), org.bccsa.luminary.player.KeyHolder(), null),
            VirtualClock(), org.bccsa.luminary.player.CreateOptions(1.0, 30.0, 5.0), presenter,
        )
        try {
            val built = engine.mediaSession.player as ExoPlayer
            assertEquals(30_000L, built.seekBackIncrement)
            assertEquals(5_000L, built.seekForwardIncrement)
        } finally {
            engine.destroy()
        }
    }

    @Test
    fun `the lock screen and notification show what JavaScript sent with the load`() {
        create()
        load(audioOnly = false, nowPlaying = buildJsonObject {
            put("title", "Episode 12")
            put("subtitle", "Sunday service")
            put("artworkUrl", "https://cdn.example.com/poster.jpg")
        })

        val metadata = engine!!.mediaSession.player.mediaMetadata
        assertEquals("Episode 12", metadata.title.toString())
        assertEquals("Sunday service", metadata.artist.toString())
        assertEquals("https://cdn.example.com/poster.jpg", metadata.artworkUri.toString())
    }

    @Test
    fun `the host's stand-in picture stays out of the metadata the system is sent, and stands in as bytes when there is no artwork`() {
        create()
        load(audioOnly = false, nowPlaying = buildJsonObject {
            put("title", "Episode 12")
            put("artworkUrl", "https://cdn.example.com/poster.jpg")
            put("fallbackArtworkUrl", "data:image/png;base64,AQID")
        })
        val metadata = engine!!.mediaSession.player.mediaMetadata
        assertEquals("https://cdn.example.com/poster.jpg", metadata.artworkUri.toString())
        assertNull(metadata.extras)

        load(audioOnly = false, nowPlaying = buildJsonObject {
            put("title", "Episode 12")
            put("fallbackArtworkUrl", "data:image/png;base64,AQID")
        })
        val alone = engine!!.mediaSession.player.mediaMetadata
        assertNull(alone.artworkUri)
        assertArrayEquals(byteArrayOf(1, 2, 3), alone.artworkData)
        assertNull(alone.extras)
    }

    @Test
    fun `a rate reaches JavaScript once per change, as the number it would have asked for`() {
        create()
        load(audioOnly = false)

        // As the skin's rate menu sets it: 0.7f reads back as 0.699999988.
        player.setPlaybackSpeed(0.7f)
        player.setPlaybackSpeed(0.7f)
        registry.call("setRate", buildJsonObject {
            put("playerId", playerId)
            put("rate", 1.5)
        })

        val rates = events.filter { it.first == "ratechange" }.map { it.second["rate"]!!.jsonPrimitive.content.toDouble() }
        assertEquals(listOf(0.7, 1.5), rates)
    }

    @Test
    fun `a load starts the service that keeps playback going with the screen locked`() {
        create()
        load(audioOnly = false)

        val started: Intent? = shadowOf(context).nextStartedService
        assertEquals(PlaybackService::class.java.name, started?.component?.className)
    }

    @Test
    fun `in the background the video track goes, and it comes back with the app`() {
        create()
        load(audioOnly = false)

        app.registry.currentState = Lifecycle.State.CREATED
        assertTrue("backgrounded: sound only", engine!!.videoDisabled)

        app.registry.currentState = Lifecycle.State.RESUMED
        assertFalse("back in front: the picture again", engine!!.videoDisabled)
    }

    @Test
    fun `destroy releases the session as well as the player`() {
        create()
        val id = engine!!.mediaSession.id
        val other = TestExoPlayerBuilder(context).build()

        // Media3 refuses a second live session with the same id, which is how a leak would show.
        val clash = runCatching { MediaSession.Builder(context, other).setId(id).build() }
        assertTrue("the session is alive before destroy", clash.exceptionOrNull() is IllegalStateException)

        registry.call("destroy", buildJsonObject { put("playerId", playerId) })

        MediaSession.Builder(context, other).setId(id).build().release()
        other.release()
    }

    @Test
    fun `play at the end starts again from the beginning`() {
        create()
        load(audioOnly = false)
        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)
        events.clear()

        call("play")
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)

        assertTrue("restarted near the start, not at the end", player.currentPosition < 1_000)
        assertTrue("and told JavaScript so", events.any { it.first == "seeked" })
    }

    private fun asset(n: Int, text: String) = buildJsonObject {
        put("uri", "luminary://asset/1/$n.m3u8")
        put("contentType", "application/vnd.apple.mpegurl")
        put("text", text)
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
    }
}
