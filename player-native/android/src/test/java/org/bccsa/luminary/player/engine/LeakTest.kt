package org.bccsa.luminary.player.engine

import android.os.Looper
import android.os.Message
import android.os.MessageQueue
import androidx.activity.ComponentActivity
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.FakeTimeline
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import java.lang.ref.WeakReference
import java.time.Duration
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.bccsa.luminary.player.BridgeCapabilities
import org.bccsa.luminary.player.EngineFactory
import org.bccsa.luminary.player.MainLooperClock
import org.bccsa.luminary.player.PlayerRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

/**
 * What repeated use must not leave behind: a loop still ticking on the main thread, or an object
 * nothing refers to that the garbage collector still cannot free.
 */
@RunWith(RobolectricTestRunner::class)
class LeakTest {
    private val context = RuntimeEnvironment.getApplication()
    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val looper = shadowOf(Looper.getMainLooper())

    private fun readyPlayer(): ExoPlayer = TestExoPlayerBuilder(context).build().also { player ->
        val timeline = FakeTimeline(FakeTimeline.TimelineWindowDefinition.Builder().setDurationUs(30_000_000L).build())
        player.setMediaSource(FakeMediaSource(timeline))
        player.prepare()
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
    }

    private fun freed(reference: WeakReference<*>): Boolean {
        repeat(20) {
            System.gc()
            System.runFinalization()
            if (reference.get() == null) return true
            Thread.sleep(50)
        }
        return false
    }

    /** What is waiting to run on the main thread, by callback and target; empty when nothing is. */
    private fun pendingOnMainThread(): List<String> {
        looper.idle()
        val queue = Looper.getMainLooper().queue
        val head = MessageQueue::class.java.getDeclaredField("mMessages").apply { isAccessible = true }.get(queue) as Message?
        return generateSequence(head) { message ->
            Message::class.java.getDeclaredField("next").apply { isAccessible = true }.get(message) as Message?
        }.map { "${it.callback?.javaClass?.name ?: "what=${it.what}"} -> ${it.target?.javaClass?.name} in ${it.`when` - android.os.SystemClock.uptimeMillis()} ms" }.toList()
    }

    /** The Activity's own window keeps a message or two waiting; that is Android's, not ours. */
    private fun ours(pending: List<String>) = pending.filterNot { "ViewRootImpl" in it }

    private fun create(registry: PlayerRegistry) = registry.call("create", buildJsonObject {
        put("protocolVersion", 1)
        put("skipBackSeconds", 10)
        put("skipForwardSeconds", 10)
    }).jsonObject.getValue("playerId").jsonPrimitive.content

    @Test
    fun `with no player ever created, only the window system is waiting`() {
        // The baseline that makes the other two checks fair: whatever is pending here is not ours.
        assertTrue(pendingOnMainThread().all { "ViewRootImpl" in it })
    }

    @Test
    fun `entering and leaving full-screen many times leaves no loop running and frees the views`() {
        val player = readyPlayer()
        val presenter = FullscreenPresenter { activity }
        var last: WeakReference<SkinControls>? = null

        repeat(50) {
            assertTrue(presenter.present(player, onLeave = {}))
            player.play()
            looper.idleFor(Duration.ofMillis(700))
            last = WeakReference(presenter.skinControls())
            assertTrue(presenter.dismiss())
        }
        player.pause()

        assertEquals("still scheduled after the last view was dismissed", emptyList<String>(), ours(pendingOnMainThread()))
        assertTrue("the last full-screen view cannot be freed", freed(last!!))
        player.release()
    }

    @Test
    fun `creating and destroying players many times leaves no loop running and frees the engines`() {
        val engines = mutableListOf<WeakReference<ExoEngine>>()
        val registry = PlayerRegistry(
            BridgeCapabilities(variantSwitching = true),
            MainLooperClock(),
            upstream = null,
            EngineFactory { router, clock, options ->
                ExoEngine(context, router, clock, options, FullscreenPresenter { activity }, readyPlayer())
                    .also { engines += WeakReference(it) }
            },
        ) { _, _ -> }

        repeat(30) {
            val id = create(registry)
            registry.call("destroy", buildJsonObject { put("playerId", id) })
        }

        assertEquals("still scheduled after every player was destroyed", emptyList<String>(), ours(pendingOnMainThread()))
        assertEquals("engines that cannot be freed after destroy", 0, engines.count { !freed(it) })
    }

    @Test
    fun `every media session is released with its player`() {
        val registry = PlayerRegistry(
            BridgeCapabilities(),
            MainLooperClock(),
            upstream = null,
            EngineFactory { router, clock, options ->
                ExoEngine(context, router, clock, options, FullscreenPresenter { activity }, readyPlayer())
            },
        ) { _, _ -> }
        repeat(10) { registry.call("destroy", buildJsonObject { put("playerId", create(registry)) }) }

        // A leaked session keeps its id, and media3 refuses a second one under it. Ids are handed
        // out in order per process, so probe the range these cycles used.
        val probe = TestExoPlayerBuilder(context).build()
        val leaked = (1..60).count { n ->
            val session = runCatching { MediaSession.Builder(context, probe).setId("luminary-player-$n").build() }
            session.onSuccess { it.release() }
            session.isFailure
        }
        probe.release()
        assertEquals("sessions still alive after their players were destroyed", 0, leaked)
    }
}
