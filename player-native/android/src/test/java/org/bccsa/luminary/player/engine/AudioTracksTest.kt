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

/** How `ExoEngine` names audio tracks, as an encoder's demuxed renditions reach it. */
@RunWith(RobolectricTestRunner::class)
class AudioTracksTest {
    private fun audio(language: String, id: String? = null) = Tracks.Group(
        TrackGroup(Format.Builder().setId(id).setLanguage(language).setSampleMimeType(MimeTypes.AUDIO_AAC).build()),
        false,
        intArrayOf(C.FORMAT_HANDLED),
        booleanArrayOf(false),
    )

    private val video = Tracks.Group(
        TrackGroup(Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setHeight(720).build()),
        false,
        intArrayOf(C.FORMAT_HANDLED),
        booleanArrayOf(true),
    )

    @Test
    fun `renditions in a group each, with no id, get one id apiece in the master's order`() {
        val tracks = Tracks(listOf(video, audio("en"), audio("es"), audio("fr"), audio("de")))

        val refs = audioTracksOf(tracks)

        assertEquals(listOf("audio-0", "audio-1", "audio-2", "audio-3"), refs.map { it.id })
        assertEquals(listOf("en", "es", "fr", "de"), refs.map { it.group.getTrackFormat(it.index).language })
    }

    @Test
    fun `an id the format carries is kept`() {
        val tracks = Tracks(listOf(audio("en", id = "aud:English"), audio("fr")))

        assertEquals(listOf("aud:English", "audio-1"), audioTracksOf(tracks).map { it.id })
    }
}
