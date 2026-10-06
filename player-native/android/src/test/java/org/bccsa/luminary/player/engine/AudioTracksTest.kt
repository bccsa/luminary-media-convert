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

    private fun rendition(language: String?, label: String, id: String) = Tracks.Group(
        TrackGroup(
            Format.Builder().setId(id).setLanguage(language).setLabel(label).setSampleMimeType(MimeTypes.AUDIO_AAC).build(),
        ),
        false,
        intArrayOf(C.FORMAT_HANDLED),
        booleanArrayOf(false),
    )

    @Test
    fun `a language offered by every audio group is one track, in the order languages first appear`() {
        // Three groups (mono, stereo, hq), each with the same languages: 6 renditions, 2 tracks.
        val tracks = Tracks(
            listOf(
                rendition("eng", "English", "mono:eng"), rendition("fra", "Française", "mono:fra"),
                rendition("eng", "English", "stereo:eng"), rendition("fra", "Française", "stereo:fra"),
                rendition("eng", "English", "hq:eng"), rendition("fra", "Française", "hq:fra"),
            ),
        )

        val choices = audioChoicesOf(tracks)

        assertEquals(listOf("mono:eng", "mono:fra"), choices.map { it.id })
        assertEquals(listOf("English", "Française"), choices.map { it.label })
        assertEquals(3, choices.first().members.size)
    }

    @Test
    fun `renditions with no language are told apart by their label`() {
        val tracks = Tracks(listOf(rendition(null, "Commentary", "a"), rendition(null, "Original", "b"), rendition(null, "Commentary", "c")))

        assertEquals(listOf("a", "b"), audioChoicesOf(tracks).map { it.id })
    }

    @Test
    fun `choosing a language asks for it by preference, so it follows the variant, and a track with no language is pinned`() {
        val player = androidx.media3.test.utils.TestExoPlayerBuilder(org.robolectric.RuntimeEnvironment.getApplication()).build()
        try {
            val tracks = Tracks(listOf(rendition("eng", "English", "a:eng"), rendition("fra", "Française", "a:fra"), rendition(null, "Original", "o")))
            val (english, french, original) = audioChoicesOf(tracks)

            selectAudio(player, french)
            // Media3 normalises language tags, as it does when it matches them.
            assertEquals(listOf("fr"), player.trackSelectionParameters.preferredAudioLanguages)
            assertEquals(0, player.trackSelectionParameters.overrides.size)

            selectAudio(player, original)
            assertEquals(emptyList<String>(), player.trackSelectionParameters.preferredAudioLanguages)
            assertEquals(1, player.trackSelectionParameters.overrides.size)

            selectAudio(player, english)
            assertEquals(listOf("en"), player.trackSelectionParameters.preferredAudioLanguages)
            assertEquals(0, player.trackSelectionParameters.overrides.size)
        } finally {
            player.release()
        }
    }
}
