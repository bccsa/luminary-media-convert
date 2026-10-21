package org.bccsa.luminary.player.engine

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.View
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import org.bccsa.luminary.player.InlineFrame
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

/** The picture shown in the page: behind the web view, where JavaScript says, and gone when it says so. */
@RunWith(RobolectricTestRunner::class)
class InlinePresenterTest {
    private val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
    private val container = FrameLayout(activity)
    private val web = View(activity).apply { background = ColorDrawable(Color.WHITE) }
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private val presenter = InlinePresenter({ web }, { activity })
    private val density = activity.resources.displayMetrics.density

    init {
        container.addView(web, FrameLayout.LayoutParams(800, 1600))
        activity.setContentView(container)
    }

    @After
    fun tearDown() {
        presenter.destroy()
        player.release()
    }

    @Test
    fun `the picture goes behind the web view, in the frame the page named`() {
        presenter.setFrame(InlineFrame(10.0, 72.0, 390.0, 219.0), player)

        val view = presenter.view!!
        assertTrue("behind the web view", container.indexOfChild(view) < container.indexOfChild(web))
        assertEquals((390 * density).toInt(), view.layoutParams.width)
        assertEquals((219 * density).toInt(), view.layoutParams.height)
        assertEquals(10 * density, view.x, 0.5f)
        assertEquals(72 * density, view.y, 0.5f)
        assertSame(player, view.player)
    }

    @Test
    fun `the web view is made see-through while the picture shows, and put back when it goes`() {
        val before = web.background
        presenter.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)
        assertEquals(Color.TRANSPARENT, (web.background as ColorDrawable).color)

        presenter.setFrame(null, player)
        assertNull(presenter.view)
        assertSame(before, web.background)
        assertEquals(1, container.childCount)
    }

    @Test
    fun `a small picture in front carries the page's chevron at its top-left, and only when asked`() {
        presenter.setFrame(InlineFrame(20.0, 600.0, 114.0, 64.0, front = true, badge = true), player)
        val view = presenter.view!!
        val badge = (0 until container.childCount).map { container.getChildAt(it) }.filterIsInstance<ExpandBadge>().single()

        assertEquals(View.VISIBLE, badge.visibility)
        assertEquals(view.x + 6 * density, badge.x, 0.5f)
        assertEquals(view.y + 10 * density, badge.y, 0.5f)
        assertTrue("over the picture", badge.z > view.z)
        assertTrue("taps go through to the page", !badge.isClickable)

        presenter.setFrame(InlineFrame(20.0, 600.0, 114.0, 64.0, front = true), player)
        assertEquals(View.GONE, badge.visibility)

        presenter.setFrame(null, player)
        assertTrue((0 until container.childCount).none { container.getChildAt(it) is ExpandBadge })
    }

    @Test
    fun `a new frame moves the same view`() {
        presenter.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)
        val view = presenter.view

        presenter.setFrame(InlineFrame(20.0, 30.0, 200.0, 150.0), player)

        assertSame(view, presenter.view)
        assertEquals(3, container.childCount)
        assertEquals(20 * density, view!!.x, 0.5f)
        assertEquals((200 * density).toInt(), view.layoutParams.width)
    }

    @Test
    fun `while full-screen holds the picture the inline view has none, and takes the player back`() {
        presenter.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)
        val view = presenter.view!!

        presenter.setSuspended(true)
        assertNull(view.player)
        presenter.setSuspended(false)
        assertSame(player, view.player)
    }

    @Test
    fun `a frame arriving while suspended shows nothing until the picture is back`() {
        presenter.setSuspended(true)
        presenter.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)
        assertNull(presenter.view!!.player)

        presenter.setSuspended(false)
        assertNotNull(presenter.view!!.player)
    }

    @Test
    fun `the picture follows the web view when it moves`() {
        presenter.setFrame(InlineFrame(0.0, 40.0, 100.0, 100.0), player)
        web.y = 60f
        web.layout(0, 0, 800, 1600)

        assertEquals(60f + 40 * density, presenter.view!!.y, 0.5f)
    }

    @Test
    fun `no web view, no picture`() {
        val without = InlinePresenter({ null })
        without.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)
        assertNull(without.view)
    }

    @Test
    fun `the last frame stays up for a reload of the same video, and goes for another one`() {
        presenter.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)
        assertTrue(keepsContent(presenter.view!!))

        presenter.keepLastFrame(false)
        assertEquals(false, keepsContent(presenter.view!!))

        presenter.keepLastFrame(true)
        assertTrue(keepsContent(presenter.view!!))
    }

    @Test
    fun `a view made after the choice starts with it`() {
        presenter.keepLastFrame(false)
        presenter.setFrame(InlineFrame(0.0, 0.0, 100.0, 100.0), player)

        assertEquals(false, keepsContent(presenter.view!!))
    }

    /** PlayerView has no public getter for this flag. */
    private fun keepsContent(view: androidx.media3.ui.PlayerView): Boolean =
        androidx.media3.ui.PlayerView::class.java
            .getDeclaredField("keepContentOnPlayerReset")
            .apply { isAccessible = true }
            .getBoolean(view)
}
