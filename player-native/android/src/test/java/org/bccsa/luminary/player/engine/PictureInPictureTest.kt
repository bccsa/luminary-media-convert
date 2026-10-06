package org.bccsa.luminary.player.engine

import android.content.res.Configuration
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.test.utils.TestExoPlayerBuilder
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

/**
 * The small window picture in picture gives the picture, as the activity tells it: nothing but the
 * picture in it, full-screen again when it is expanded, and leaving when it is closed.
 */
@RunWith(RobolectricTestRunner::class)
class PictureInPictureTest {
    private val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
    private val activity = controller.get()
    private val player: ExoPlayer = TestExoPlayerBuilder(activity).build()
    private val presenter = FullscreenPresenter { activity }
    private val presentations = mutableListOf<String>()
    private var left = 0

    private fun present() = presenter.present(player, onLeave = { left++ }, onPresentation = { presentations += it })

    private fun pictureInPicture(active: Boolean) = activity.onPictureInPictureModeChanged(active, Configuration())

    private fun settle() = shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))

    @After
    fun tearDown() {
        presenter.dismiss()
        player.release()
    }

    @Test
    fun `in its small window the picture shows alone, and the page is told`() {
        present()
        val controls = presenter.skinControls()!!

        pictureInPicture(true)

        assertEquals(listOf("pip"), presentations)
        assertTrue("no controls over a small picture", controls.find("Pause") == null && controls.find("Play") == null)
    }

    @Test
    fun `expanded, it is full-screen again with its controls`() {
        present()
        pictureInPicture(true)

        pictureInPicture(false)
        settle()

        assertEquals(listOf("pip", "fullscreen"), presentations)
        assertEquals(0, left)
        assertTrue(presenter.skinControls()!!.find("Play") != null)
    }

    @Test
    fun `expanded, it is full-screen again however long the activity takes to come back`() {
        present()
        pictureInPicture(true)
        // An activity in the small window is paused; the expand animation leaves it so for a moment.
        controller.pause()

        pictureInPicture(false)
        settle()
        assertEquals(listOf("pip"), presentations)
        assertEquals(0, left)

        controller.resume()
        assertEquals(listOf("pip", "fullscreen"), presentations)
        assertEquals(0, left)
    }

    @Test
    fun `closed after a moment, it is leaving once it has stayed stopped`() {
        present()
        pictureInPicture(true)
        controller.pause()

        pictureInPicture(false)
        controller.stop()
        assertEquals("a stop alone is not yet the answer", 0, left)
        settle()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1500))

        assertEquals(listOf("pip"), presentations)
        assertEquals(1, left)
    }

    @Test
    fun `an activity already stopped when the small window ends is expanded if it comes back`() {
        present()
        pictureInPicture(true)
        controller.pause().stop()

        pictureInPicture(false)
        assertEquals("a stopped activity is not yet the answer", 0, left)
        controller.start().resume()

        assertEquals(listOf("pip", "fullscreen"), presentations)
        assertEquals(0, left)
    }

    @Test
    fun `an activity stopped and started on the way to expanded is expanded`() {
        present()
        pictureInPicture(true)
        controller.pause()

        pictureInPicture(false)
        controller.stop()
        controller.start().resume()

        assertEquals(listOf("pip", "fullscreen"), presentations)
        assertEquals(0, left)
    }

    @Test
    fun `closed, it is leaving`() {
        present()
        pictureInPicture(true)
        // Closing the small window sends the activity to the background.
        controller.pause().stop()

        pictureInPicture(false)
        settle()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1500))

        assertEquals(listOf("pip"), presentations)
        assertEquals(1, left)
    }

    @Test
    fun `once dismissed, the activity's picture in picture is none of its business`() {
        present()
        presenter.dismiss()

        pictureInPicture(true)
        pictureInPicture(false)
        settle()

        assertEquals(emptyList<String>(), presentations)
        assertEquals(0, left)
    }

    @Test
    fun `where the system or the activity does not allow it, there is no button and no small window`() {
        // Robolectric's package manager has no picture in picture feature.
        present()
        assertFalse(FullscreenPresenter.pictureInPictureAvailable(activity))
        assertFalse(presenter.startPictureInPicture())
        assertNull(presenter.skinControls()!!.find("Picture-in-Picture"))
    }

    private fun View.find(description: String): View? =
        ArrayList<View>().also { findViewsWithText(it, description, View.FIND_VIEWS_WITH_CONTENT_DESCRIPTION) }
            .firstOrNull { it.contentDescription?.toString() == description }

    private fun subtitle(language: String?, label: String?) = Tracks.Group(
        TrackGroup(Format.Builder().setSampleMimeType(MimeTypes.TEXT_VTT).setLanguage(language).setLabel(label).build()),
        false,
        intArrayOf(C.FORMAT_HANDLED),
        booleanArrayOf(false),
    )

    @Test
    fun `a master's subtitles are listed by name, else by language, in its order`() {
        val tracks = Tracks(listOf(subtitle("en", "English"), subtitle("fr", null), subtitle(null, null)))

        assertEquals(listOf("English", "fr", "Subtitles 3"), subtitleChoicesOf(tracks).map { it.label })
    }

    @Test
    fun `subtitles off disables the text renderer, and showing one enables it again`() {
        val tracks = Tracks(listOf(subtitle("en", "English")))

        selectSubtitle(player, null as SubtitleChoice?)
        assertTrue(player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))

        selectSubtitle(player, subtitleChoicesOf(tracks).single())
        assertFalse(player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
        assertEquals(1, player.trackSelectionParameters.overrides.size)
    }
}
