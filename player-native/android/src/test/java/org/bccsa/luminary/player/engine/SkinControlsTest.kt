package org.bccsa.luminary.player.engine

import android.graphics.Bitmap
import android.net.Uri
import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.ImageView
import androidx.activity.ComponentActivity
import androidx.media3.common.Player
import androidx.media3.common.util.BitmapLoader
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.FakeMediaSource
import androidx.media3.test.utils.FakeTimeline
import androidx.media3.test.utils.TestExoPlayerBuilder
import androidx.media3.test.utils.robolectric.TestPlayerRunHelper
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import java.time.Duration
import org.bccsa.luminary.player.Browse
import org.bccsa.luminary.player.BrowseChapter
import org.bccsa.luminary.player.BrowseItem
import org.bccsa.luminary.player.Thumbnails
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

    /** By exact description: the platform's search is a substring match, and "Play" finds "Playback Rate". */
    private fun SkinControls.find(description: String): View? =
        ArrayList<View>().also { findViewsWithText(it, description, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION) }
            .firstOrNull { it.contentDescription?.toString() == description }

    private fun idle(millis: Long) = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(millis))

    @After
    fun tearDown() = player.release()

    @Test
    fun `the time played and the time left follow the player`() {
        val controls = controls()
        player.seekTo(7_400)
        idle(300)
        // The time played before the timeline, the time left after it.
        assertTrue(controls.texts().contains("0:07"))
        assertTrue(controls.texts().contains("-0:23"))
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
    fun `the controls say what the host sent, and English for the rest`() {
        val texts = FullscreenTexts.from(
            mapOf("exitFullscreen" to "Quitter le plein écran", "skipBack" to "Reculer de {seconds} secondes", "mute" to "Couper le son"),
        )
        val controls = SkinControls(activity, player, SkinOptions(), texts) {}.also { activity.setContentView(it) }

        assertNotNull(controls.find("Quitter le plein écran"))
        assertNotNull(controls.find("Reculer de 10 secondes"))
        assertNotNull(controls.find("Couper le son"))
        // Not sent: English.
        assertNotNull(controls.find("Skip forward 10 seconds"))
    }

    @Test
    fun `on live the exit button stays in the corner, the time says LIVE, and skip and rate are gone`() {
        val live: ExoPlayer = TestExoPlayerBuilder(activity).build()
        try {
            val window = FakeTimeline.TimelineWindowDefinition.Builder().setLive(true).setDynamic(true).setDurationUs(androidx.media3.common.C.TIME_UNSET).build()
            live.setMediaSource(FakeMediaSource(FakeTimeline(window)))
            live.prepare()
            TestPlayerRunHelper.advance(live).untilState(Player.STATE_READY)
            val controls = SkinControls(activity, live, SkinOptions()) {}.also { activity.setContentView(it) }
            val density = activity.resources.displayMetrics.density
            val width = (800 * density).toInt()
            val height = (400 * density).toInt()
            controls.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
            )
            controls.layout(0, 0, width, height)

            assertTrue(controls.texts().contains("LIVE"))
            assertNull(controls.find("Skip back 10 seconds"))
            assertNull(controls.find("Playback Rate"))
            val exit = controls.find("Exit full screen")!!
            val rect = android.graphics.Rect().also { exit.getHitRect(it) }
            var right = rect.right
            var parent = exit.parent
            while (parent is View && parent !== controls) {
                right += (parent as View).left
                parent = parent.parent
            }
            assertTrue("the exit button is at ${right}px of $width", right > width - (60 * density))
        } finally {
            live.release()
        }
    }

    /** The timeline is private to the skin, so it is found by its class name in the view tree. */
    private fun SkinControls.timeline(): View {
        fun walk(view: View): View? {
            if (view.javaClass.simpleName == "Timeline") return view
            val group = view as? android.view.ViewGroup ?: return null
            return (0 until group.childCount).firstNotNullOfOrNull { walk(group.getChildAt(it)) }
        }
        return checkNotNull(walk(this))
    }

    private fun touch(view: View, action: Int, x: Float, at: Long): MotionEvent =
        MotionEvent.obtain(at, at, action, x, view.height / 2f, 0)

    @Test
    fun `a tap on the timeline seeks and keeps playing`() {
        val controls = controls()
        controls.measure(android.view.View.MeasureSpec.makeMeasureSpec(1080, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(1920, android.view.View.MeasureSpec.EXACTLY))
        controls.layout(0, 0, 1080, 1920)
        player.play()
        val timeline = controls.timeline()
        val now = SystemClock.uptimeMillis()
        timeline.onTouchEvent(touch(timeline, MotionEvent.ACTION_DOWN, timeline.width / 2f, now))
        timeline.onTouchEvent(touch(timeline, MotionEvent.ACTION_UP, timeline.width / 2f, now + 50))
        assertTrue(player.playWhenReady)
    }

    @Test
    fun `dragging along the timeline holds the video still, and it plays on when the finger lifts`() {
        val controls = controls()
        controls.measure(android.view.View.MeasureSpec.makeMeasureSpec(1080, android.view.View.MeasureSpec.EXACTLY), android.view.View.MeasureSpec.makeMeasureSpec(1920, android.view.View.MeasureSpec.EXACTLY))
        controls.layout(0, 0, 1080, 1920)
        player.play()
        val timeline = controls.timeline()
        val now = SystemClock.uptimeMillis()
        val start = timeline.width / 4f
        timeline.onTouchEvent(touch(timeline, MotionEvent.ACTION_DOWN, start, now))
        timeline.onTouchEvent(touch(timeline, MotionEvent.ACTION_MOVE, start + 200f, now + 50))
        assertFalse(player.playWhenReady)
        timeline.onTouchEvent(touch(timeline, MotionEvent.ACTION_UP, start + 200f, now + 100))
        assertTrue(player.playWhenReady)
    }

    @Test
    fun `a tap on another control closes an open menu`() {
        val controls = controls()
        controls.find("Playback Rate")!!.performClick()
        assertTrue(controls.hasMenuOpen)

        controls.find("Mute")!!.performClick()
        assertFalse(controls.hasMenuOpen)
    }

    @Test
    fun `the rate button says its value to a screen reader`() {
        val controls = controls()
        val description = androidx.core.view.ViewCompat.getStateDescription(controls.find("Playback Rate")!!)
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

        assertNotNull(controls.find("Skip back 30 seconds"))
        assertNotNull(controls.find("Skip forward 5 seconds"))
    }

    @Test
    fun `a skip circle jumps by exactly its label, whatever the player was configured with`() {
        val controls = controls()
        player.seekTo(12_000)

        controls.find("Skip forward 10 seconds")!!.performClick()
        assertEquals(22_000, player.currentPosition)
        controls.find("Skip back 10 seconds")!!.performClick()
        assertEquals(12_000, player.currentPosition)
    }

    @Test
    fun `a skip never leaves the item`() {
        val controls = controls()
        player.seekTo(2_000)
        controls.find("Skip back 10 seconds")!!.performClick()
        assertEquals(0, player.currentPosition)

        player.seekTo(28_000)
        controls.find("Skip forward 10 seconds")!!.performClick()
        // ExoPlayer reports the last millisecond of an item as its position, never past it.
        assertTrue(player.currentPosition in 29_900..30_000)
    }

    @Test
    fun `no circle for a direction that skips nowhere`() {
        val controls = controls(SkinOptions(skipBackSeconds = 0.0, skipForwardSeconds = 10.0))

        assertNull(controls.find("Skip back 10 seconds"))
        assertNotNull(controls.find("Skip forward 10 seconds"))
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
    fun `at the end of the item the button says play, and it plays again from the start`() {
        val controls = controls()
        player.playWhenReady = true
        player.seekTo(29_999)
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_ENDED)
        idle(300)

        // Playback is still "wanted" at the end; the button must not read it as playing.
        assertNotNull(controls.find("Play"))
        assertNull(controls.find("Pause"))
        controls.find("Play")!!.performClick()
        assertTrue(player.currentPosition < 1_000)
    }

    @Test
    fun `0_7x shows selected, though the player keeps the speed as a float`() {
        val controls = controls()
        player.setPlaybackSpeed(0.7f)
        controls.find("Playback Rate")!!.performClick()

        // The chosen row is the one marked selected (it is ticked and lit); the others are not.
        val chosen = ArrayList<View>().also { collectTexts(controls, it) }
            .filter { it.isSelected && it.contentDescription?.toString()?.endsWith("x") == true }
            .map { it.contentDescription.toString() }
        assertEquals(listOf("0.7x"), chosen)
    }

    private fun collectTexts(view: View, into: MutableList<View>) {
        into += view
        if (view is android.view.ViewGroup) for (i in 0 until view.childCount) collectTexts(view.getChildAt(i), into)
    }

    @Test
    fun `the skip circles sit 100 dp either side of the middle of play, on its centre line, scaled with the controls`() {
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

        val (backX, backY) = controls.find("Skip back 10 seconds")!!.centre()
        val (forwardX, forwardY) = controls.find("Skip forward 10 seconds")!!.centre()
        val (playX, playY) = controls.find("Play")!!.centre()

        // Half of play (40), the 32 between, and half of a skip (28), at the 1.2 of a phone on its side.
        assertEquals(playX - 120 * density, backX, 1f)
        assertEquals(playX + 120 * density, forwardX, 1f)
        assertEquals(playY, backY, 1f)
        assertEquals(playY, forwardY, 1f)
    }

    @Test
    fun `the exit button leaves`() {
        controls().find("Exit full screen")!!.performClick()

        assertEquals(1, left)
    }

    @Test
    fun `the rate menu lists the skin's rates, marks the current one, and applies a choice`() {
        val controls = controls()
        controls.find("Playback Rate")!!.performClick()

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

        // The three seconds start at play(), so time spent loading counts against them.
        val playedAt = SystemClock.uptimeMillis()
        player.play()
        TestPlayerRunHelper.advance(player).untilState(Player.STATE_READY)
        val loading = SystemClock.uptimeMillis() - playedAt
        idle(2_900 - loading)
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
        controls.find("Playback Rate")!!.performClick()

        idle(10_000)
        assertTrue(controls.controlsShown)
    }

    // The chapters / up-next panel.

    private val lists = Browse(
        chapters = listOf(BrowseChapter("Intro", 0.0, 10.0), BrowseChapter("Middle", 10.0, 20.0), BrowseChapter("End", 20.0, 30.0)),
        upNext = listOf(
            BrowseItem("p2", "Part 2", "Season 1", "https://cdn/p2.jpg", "Next in series"),
            BrowseItem("p3", "Part 3", null, null, "Next in series"),
            BrowseItem("r1", "Something else", "Related one", null, "Related"),
        ),
    )

    private fun browseControls(
        browse: Browse? = lists,
        picked: MutableList<String> = mutableListOf(),
        texts: FullscreenTexts = FullscreenTexts(),
    ): SkinControls =
        SkinControls(activity, player, SkinOptions(), texts, browse = browse, onBrowseSelect = { picked += it }) { left++ }
            .also { activity.setContentView(it) }

    private val opener = "Chapters and up next"

    @Test
    fun `a pick shows the spinner from the tap, while the page prepares the video, and only for a while`() {
        val picked = mutableListOf<String>()
        val controls = browseControls(picked = picked)
        controls.find(opener)!!.performClick()
        controls.anyView("More videos").performClick()
        controls.find("Part 2, Season 1")!!.performClick()

        assertEquals(listOf("p2"), picked)
        assertEquals(View.VISIBLE, controls.anyView("Loading").visibility)
        // The same item playing on is not the pick arriving.
        player.play()
        idle(500)
        assertEquals(View.VISIBLE, controls.anyView("Loading").visibility)
        // Nothing came: the controls are back.
        idle(15_000)
        assertEquals(View.GONE, controls.anyView("Loading").visibility)
    }

    @Test
    fun `the panel button is there only while there is something to list`() {
        assertNull(browseControls(browse = null).find(opener))
        assertNull(browseControls(browse = Browse(emptyList(), emptyList())).find(opener))
        assertNotNull(browseControls().find(opener))
    }

    @Test
    fun `the panel opens on chapters, with a tab for each list that has entries`() {
        val controls = browseControls()
        controls.find(opener)!!.performClick()

        assertTrue(controls.hasBrowseOpen)
        assertTrue(controls.anyView("Chapters").isSelected)
        assertFalse(controls.anyView("More videos").isSelected)
        assertNotNull(controls.find("Intro, 0:00"))
        assertNotNull(controls.find("Middle, 0:10"))
        assertNull("the other tab's list is not drawn", controls.find("Part 2, Season 1"))

        controls.anyView("More videos").performClick()
        assertTrue(controls.anyView("More videos").isSelected)
        assertNotNull(controls.find("Part 2, Season 1"))
        assertNull(controls.find("Intro, 0:00"))
    }

    @Test
    fun `a list with no entries has no tab, and the panel opens on the other`() {
        val controls = browseControls(browse = Browse(emptyList(), lists.upNext))
        controls.find(opener)!!.performClick()

        assertNull(controls.find("Chapters"))
        assertTrue(controls.anyView("More videos").isSelected)
        assertNotNull(controls.find("Part 3"))
    }

    @Test
    fun `a chapter marks the one the playhead is in, follows playback, and seeks and closes when tapped`() {
        val controls = browseControls()
        player.seekTo(12_000)
        idle(300)
        controls.find(opener)!!.performClick()

        assertTrue(controls.find("Middle, 0:10")!!.isSelected)
        assertFalse(controls.find("Intro, 0:00")!!.isSelected)

        player.seekTo(25_000)
        idle(300)
        assertTrue(controls.find("End, 0:20")!!.isSelected)
        assertFalse(controls.find("Middle, 0:10")!!.isSelected)

        controls.find("Intro, 0:00")!!.performClick()
        idle(10)
        assertEquals(0, player.currentPosition)
        assertFalse(controls.hasBrowseOpen)
    }

    @Test
    fun `an up-next row hands its id out and closes the panel`() {
        val picked = mutableListOf<String>()
        val controls = browseControls(picked = picked)
        controls.find(opener)!!.performClick()
        controls.anyView("More videos").performClick()

        controls.find("Something else, Related one")!!.performClick()

        assertEquals(listOf("r1"), picked)
        assertFalse(controls.hasBrowseOpen)
    }

    @Test
    fun `a section heading shows once over each run of items that share it`() {
        val controls = browseControls()
        controls.find(opener)!!.performClick()
        controls.anyView("More videos").performClick()

        val texts = controls.texts()
        assertEquals(1, texts.count { it == "NEXT IN SERIES" })
        assertEquals(1, texts.count { it == "RELATED" })
        assertTrue(texts.indexOf("NEXT IN SERIES") < texts.indexOf("Part 2"))
        assertTrue(texts.indexOf("Part 3") < texts.indexOf("RELATED"))
    }

    @Test
    fun `an up-next row has a tile for its picture, whether or not it has one to load`() {
        val controls = browseControls()
        controls.find(opener)!!.performClick()
        controls.anyView("More videos").performClick()

        val pictures = ArrayList<View>().also { collect(controls, it) }.filterIsInstance<ImageView>()
        assertEquals(3, pictures.size)
    }

    @Test
    fun `the panel closes from its close button, from outside the sheet, and from back, and back reports whether it did`() {
        val controls = browseControls()
        assertFalse("nothing to close yet", controls.closeBrowse())

        controls.find(opener)!!.performClick()
        controls.find("Close")!!.performClick()
        assertFalse(controls.hasBrowseOpen)

        controls.find(opener)!!.performClick()
        // The scrim is the first thing in the panel's layer, behind the sheet.
        val layer = controls.getChildAt(controls.childCount - 1) as android.view.ViewGroup
        layer.getChildAt(0).performClick()
        assertFalse(controls.hasBrowseOpen)

        controls.find(opener)!!.performClick()
        assertTrue(controls.closeBrowse())
        assertFalse(controls.hasBrowseOpen)
        assertEquals("closing the panel does not leave full-screen", 0, left)
    }

    @Test
    fun `an open panel keeps the controls up`() {
        val controls = browseControls()
        player.play()
        controls.find(opener)!!.performClick()

        idle(10_000)
        assertTrue(controls.controlsShown)

        controls.closeBrowse()
        idle(3_100)
        assertFalse(controls.controlsShown)
    }

    @Test
    fun `lists that arrive while the panel is open replace the ones on screen, and none takes the button and panel away`() {
        val controls = browseControls(browse = Browse(lists.chapters, emptyList()))
        controls.find(opener)!!.performClick()
        assertNull(controls.find("More videos"))

        controls.setBrowse(lists)
        assertNotNull(controls.find("More videos"))
        assertNotNull("still on chapters", controls.find("Intro, 0:00"))

        controls.setBrowse(null)
        assertFalse(controls.hasBrowseOpen)
        assertNull(controls.find(opener))
    }

    @Test
    fun `a button that appears with late lists`() {
        val controls = browseControls(browse = null)
        assertNull(controls.find(opener))

        controls.setBrowse(lists)

        assertNotNull(controls.find(opener))
    }

    @Test
    fun `the panel says what the host sent`() {
        val texts = FullscreenTexts.from(mapOf("chapters" to "Chapitres", "upNext" to "À suivre", "browse" to "Chapitres et suite", "closeBrowse" to "Fermer"))
        val controls = browseControls(texts = texts)
        controls.find("Chapitres et suite")!!.performClick()

        assertNotNull(controls.find("Chapitres"))
        assertNotNull(controls.find("À suivre"))
        assertNotNull(controls.find("Fermer"))
    }

    @Test
    fun `the panel is nearly all of a portrait phone and near half of a landscape screen, never too narrow to read`() {
        val density = activity.resources.displayMetrics.density
        fun sheetWidthDp(widthDp: Int): Float {
            val controls = browseControls()
            val width = (widthDp * density).toInt()
            val height = (400 * density).toInt()
            controls.measure(
                View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY),
            )
            controls.layout(0, 0, width, height)
            controls.find(opener)!!.performClick()
            val layer = controls.getChildAt(controls.childCount - 1) as android.view.ViewGroup
            return layer.getChildAt(1).layoutParams.width / density
        }

        // Near half of a wide screen.
        assertEquals(1600 * 0.46f, sheetWidthDp(1600), 1f)
        // A phone on its side: the readable minimum, 380 dp at its 1.2 scale.
        assertEquals(380 * 1.2f, sheetWidthDp(800), 1f)
        // Upright, the minimum would be the whole screen: never more than 92% of it.
        assertEquals(360 * 0.92f, sheetWidthDp(360), 1f)
    }

    // The scrubbed frame over the picture.

    private val framesVtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.500\nsprite_0.webp#xywh=0,0,160,90\n"

    /** The VTT is read on a worker thread, so wait for its cues to land. */
    private fun readyFrames(): Thumbnails {
        val frames = Thumbnails { url -> if (url.endsWith(".vtt")) framesVtt.toByteArray() else null }
        frames.load("https://cdn.example.com/thumbs/thumbnails.vtt", null)
        repeat(200) {
            if (frames.ready) return frames
            Thread.sleep(5)
            idle(5)
        }
        error("the frames never arrived")
    }

    /** The timeline's own reports, which are private to the controls. */
    private fun SkinControls.holdScrub(fraction: Double, x: Float) {
        javaClass.getDeclaredMethod("scrubbed", Double::class.javaPrimitiveType, Float::class.javaPrimitiveType)
            .apply { isAccessible = true }
            .invoke(this, fraction, x)
    }

    private fun SkinControls.releaseScrub(fraction: Double, commit: Boolean) {
        javaClass.getDeclaredMethod("scrubEnded", Double::class.javaPrimitiveType, Boolean::class.javaPrimitiveType)
            .apply { isAccessible = true }
            .invoke(this, fraction, commit)
    }

    private fun SkinControls.pictureView(): View =
        ArrayList<View>().also { collect(this, it) }.first { it.javaClass.simpleName == "PictureView" }

    private fun SkinControls.pictureCue(): Any? =
        pictureView().javaClass.getDeclaredField("cue").apply { isAccessible = true }.get(pictureView())

    @Test
    fun `the scrubbed frame is hidden at rest`() {
        val controls = SkinControls(activity, player, SkinOptions(), thumbnails = readyFrames()) { left++ }
            .also { activity.setContentView(it) }

        assertEquals(View.GONE, controls.pictureView().visibility)
    }

    @Test
    fun `the scrubbed frame shows while the timeline is held, and clears when it is let go`() {
        val controls = SkinControls(activity, player, SkinOptions(), thumbnails = readyFrames()) { left++ }
            .also { activity.setContentView(it) }

        controls.holdScrub(0.1, 50f)
        assertEquals(View.VISIBLE, controls.pictureView().visibility)

        controls.releaseScrub(0.1, true)
        assertEquals(View.GONE, controls.pictureView().visibility)
    }

    @Test
    fun `no scrubbed frame without frames`() {
        val controls = controls()

        controls.holdScrub(0.1, 50f)

        assertEquals(View.GONE, controls.pictureView().visibility)
    }

    @Test
    fun `past the end of a partial storyboard the frame keeps its last cue`() {
        val controls = SkinControls(activity, player, SkinOptions(), thumbnails = readyFrames()) { left++ }
            .also { activity.setContentView(it) }

        // 0.3 s, on the only cue the storyboard has.
        controls.holdScrub(0.01, 50f)
        val onCue = controls.pictureCue()
        assertNotNull(onCue)

        // 27 s, past the 2.5 s the storyboard covers.
        controls.holdScrub(0.9, 50f)
        assertEquals(onCue, controls.pictureCue())
        assertEquals(View.VISIBLE, controls.pictureView().visibility)
    }
}
