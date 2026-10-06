package org.bccsa.luminary.player.engine

import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.FakeTimeline
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import java.time.Duration
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
import org.robolectric.Shadows.shadowOf

/** The full-screen controls, on a player with a 30-second fake timeline so skips have room. */
@RunWith(RobolectricTestRunner::class)
class SkinControlsTest {
    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private var left = 0

    init {
        val timeline = FakeTimeline(FakeTimeline.TimelineWindowDefinition.Builder().setDurationUs(30_000_000L).build())
        player.setMediaSource(FakeMediaSource(timeline))
        player.prepare()
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
    }

    private fun controls(options: SkinOptions = SkinOptions()): SkinControls =
        SkinControls(activity, player, options) { left++ }.also { activity.setContentView(it) }

    /** By exact description: the platform's search is a substring match, and "Play" finds "Playback rate". */
    private fun SkinControls.find(description: String): View? =
        ArrayList<View>().also { findViewsWithText(it, description, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION) }
            .firstOrNull { it.contentDescription?.toString() == description }

    private fun idle(millis: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis))

    @After
    fun tearDown() = player.release()

    @Test
    fun `the time reads position over duration and follows the player`() {
        val controls = controls()
        player.seekTo(7_400)
        idle(300)
        assertTrue(controls.texts().contains("0:07 / 0:30"))
    }

    @Test
    fun `mute silences the player and says unmute, and a second tap brings the volume back`() {
        val controls = controls()
        player.volume = 0.6f

        controls.find("Mute")!!.performClick()
        assertEquals(0f, player.volume, 0f)
        assertNotNull(controls.find("Unmute"))

        controls.find("Unmute")!!.performClick()
        assertEquals(0.6f, player.volume, 0f)
        assertNotNull(controls.find("Mute"))
    }

    @Test
    fun `the spinner stands in for play while waiting for data the viewer asked for`() {
        // A source that never finishes preparing keeps the player in BUFFERING.
        val stuck: ExoPlayer = TestExoPlayerBuilder(activity).build()
        try {
            stuck.setMediaSource(FakeMediaSource(null))
            stuck.prepare()
            stuck.playWhenReady = true
            assertEquals(Player.STATE_BUFFERING, stuck.playbackState)
            val controls = SkinControls(activity, stuck, SkinOptions()) {}.also { activity.setContentView(it) }

            assertEquals(View.VISIBLE, controls.anyView("Loading").visibility)
            // Playback is wanted, so the button that is stood in for says Pause.
            assertEquals(View.INVISIBLE, controls.anyView("Pause").visibility)
        } finally {
            stuck.release()
        }
    }

    @Test
    fun `no spinner while ready, and play is back`() {
        val controls = controls()
        assertEquals(View.GONE, controls.anyView("Loading").visibility)
        assertEquals(View.VISIBLE, controls.anyView("Play").visibility)
    }

    @Test
    fun `a tap on another control closes an open menu`() {
        val controls = controls()
        controls.find("Playback rate")!!.performClick()
        assertTrue(controls.hasMenuOpen)

        controls.find("Mute")!!.performClick()
        assertFalse(controls.hasMenuOpen)
    }

    @Test
    fun `the rate button says its value to a screen reader`() {
        val controls = controls()
        val description = androidx.core.view.ViewCompat.getStateDescription(controls.find("Playback rate")!!)
        assertEquals("1x", description?.toString())
    }

    private fun SkinControls.texts(): List<String> =
        ArrayList<View>().also { collect(this, it) }.filterIsInstance<android.widget.TextView>().map { it.text.toString() }

    /** By exact description, hidden or not: `find` only sees what is visible. */
    private fun SkinControls.anyView(description: String): View =
        ArrayList<View>().also { collect(this, it) }.first { it.contentDescription?.toString() == description }

    private fun collect(view: View, into: MutableList<View>) {
        into += view
        if (view is android.view.ViewGroup) for (i in 0 until view.childCount) collect(view.getChildAt(i), into)
    }

    @Test
    fun `the skip circles carry the seconds the options snap to`() {
        val controls = controls(SkinOptions(skipBackSeconds = 30.0, skipForwardSeconds = 7.0))

        assertNotNull(controls.find("Back 30 seconds"))
        assertNotNull(controls.find("Forward 5 seconds"))
    }

    @Test
    fun `a skip circle jumps by exactly its label, whatever the player was configured with`() {
        val controls = controls()
        player.seekTo(12_000)

        controls.find("Forward 10 seconds")!!.performClick()
        assertEquals(22_000, player.currentPosition)
        controls.find("Back 10 seconds")!!.performClick()
        assertEquals(12_000, player.currentPosition)
    }

    @Test
    fun `a skip never leaves the item`() {
        val controls = controls()
        player.seekTo(2_000)
        controls.find("Back 10 seconds")!!.performClick()
        assertEquals(0, player.currentPosition)

        player.seekTo(28_000)
        controls.find("Forward 10 seconds")!!.performClick()
        // ExoPlayer reports the last millisecond of an item as its position, never past it.
        assertTrue(player.currentPosition in 29_900..30_000)
    }

    @Test
    fun `no circle for a direction that skips nowhere`() {
        val controls = controls(SkinOptions(skipBackSeconds = 0.0, skipForwardSeconds = 10.0))

        assertNull(controls.find("Back 10 seconds"))
        assertNotNull(controls.find("Forward 10 seconds"))
    }

    @Test
    fun `play and pause follow the player, and the button says which`() {
        val controls = controls()
        assertNotNull(controls.find("Play"))

        controls.find("Play")!!.performClick()
        assertTrue(player.playWhenReady)
        idle(10)
        assertNotNull(controls.find("Pause"))

        controls.find("Pause")!!.performClick()
        assertFalse(player.playWhenReady)
        idle(10)
        assertNotNull(controls.find("Play"))
    }

    @Test
    fun `the skip circles sit 72 dp either side of the middle, and a little above it`() {
        val controls = controls()
        val density = activity.resources.displayMetrics.density
        val width = (800 * density).toInt()
        val height = (400 * density).toInt()
        controls.measure(
            View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
        )
        controls.layout(0, 0, width, height)

        fun View.centre(): Pair<Float, Float> {
            val rect = android.graphics.Rect().also { getHitRect(it) }
            var x = rect.exactCenterX()
            var y = rect.exactCenterY()
            var parent = parent as? View
            while (parent != null && parent !== controls) {
                x += parent.left
                y += parent.top
                parent = parent.parent as? View
            }
            return x to y
        }

        val (backX, backY) = controls.find("Back 10 seconds")!!.centre()
        val (forwardX, forwardY) = controls.find("Forward 10 seconds")!!.centre()
        val (playX, playY) = controls.find("Play")!!.centre()

        assertEquals(playX - 72 * density, backX, 1f)
        assertEquals(playX + 72 * density, forwardX, 1f)
        assertEquals(playY - 14 * density, backY, 1f)
        assertEquals(playY - 14 * density, forwardY, 1f)
    }

    @Test
    fun `the exit button leaves`() {
        controls().find("Exit full screen")!!.performClick()

        assertEquals(1, left)
    }

    @Test
    fun `the rate menu lists the skin's rates, marks the current one, and applies a choice`() {
        val controls = controls()
        controls.find("Playback rate")!!.performClick()

        // The menu is a card of one row per rate, the current one bold.
        val items = ArrayList<View>().also { controls.findViewsWithText(it, "1.5x", View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION) }
        assertEquals(1, items.size)
        assertTrue(controls.hasMenuOpen)
        for (rate in listOf("0.5x", "0.7x", "1x")) assertNotNull(controls.find(rate))

        items.single().performClick()
        assertEquals(1.5f, player.playbackParameters.speed, 0.001f)
        assertFalse(controls.hasMenuOpen)
    }

    @Test
    fun `the controls fade after three seconds of playing, and stay while paused`() {
        val controls = controls()
        assertTrue(controls.controlsShown)

        idle(5_000)
        assertTrue("paused controls stay up", controls.controlsShown)

        player.play()
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
        idle(2_900)
        assertTrue(controls.controlsShown)
        idle(200)
        assertFalse(controls.controlsShown)
    }

    @Test
    fun `pausing brings the controls back`() {
        val controls = controls()
        player.play()
        idle(3_100)
        assertFalse(controls.controlsShown)

        player.pause()
        idle(10)
        assertTrue(controls.controlsShown)
    }

    @Test
    fun `an open menu keeps the controls up`() {
        val controls = controls()
        player.play()
        controls.find("Playback rate")!!.performClick()

        idle(10_000)
        assertTrue(controls.controlsShown)
    }
}
