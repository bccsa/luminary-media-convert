package org.bccsa.luminary.player.engine

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The tiers of a ladder, as the quality menu lists them. */
@RunWith(RobolectricTestRunner::class)
class VideoQualityTest {
    private fun ladder(vararg heights: Int, unsupported: Set<Int> = emptySet()) = Tracks.Group(
        TrackGroup(*heights.map { Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setHeight(it).build() }.toTypedArray()),
        false,
        heights.map { if (it in unsupported) C.FORMAT_EXCEEDS_CAPABILITIES else C.FORMAT_HANDLED }.toIntArray(),
        BooleanArray(heights.size),
    )

    @Test
    fun `the tiers come tallest first, one each however many bitrates share a height`() {
        val tracks = Tracks(listOf(ladder(360, 1080, 720, 1080, 480)))

        assertEquals(listOf(1080, 720, 480, 360), qualityChoicesOf(tracks, null).map { it.height })
    }

    @Test
    fun `a tier the device cannot play is left out`() {
        val tracks = Tracks(listOf(ladder(2160, 1080, 720, unsupported = setOf(2160))))

        assertEquals(listOf(1080, 720), qualityChoicesOf(tracks, null).map { it.height })
    }

    @Test
    fun `the held tier is the selected one`() {
        val choices = qualityChoicesOf(Tracks(listOf(ladder(1080, 720))), held = 720)

        assertEquals(listOf(false, true), choices.map { it.selected })
    }

    @Test
    fun `an unknown ladder offers nothing`() {
        assertEquals(emptyList<Int>(), qualityChoicesOf(Tracks.EMPTY, null).map { it.height })
    }
}
