package org.bccsa.luminary.player.engine

import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks

/** One audio track: its id, and where it sits in ExoPlayer's track groups. */
class AudioRef(val id: String, val group: Tracks.Group, val index: Int)

/**
 * Every audio track, with an id unique among them. HLS gives demuxed renditions no `Format.id` and
 * puts each in a group of its own, so the id is the track's place among all audio tracks: the
 * master's order, the same after a reattach.
 */
fun audioTracksOf(tracks: Tracks): List<AudioRef> {
    val refs = mutableListOf<AudioRef>()
    for (group in tracks.groups) {
        if (group.type != C.TRACK_TYPE_AUDIO) continue
        for (i in 0 until group.length) {
            refs += AudioRef(group.getTrackFormat(i).id ?: "audio-${refs.size}", group, i)
        }
    }
    return refs
}

/**
 * One audio track as the bridge and the menus list it. A ladder whose audio comes in more than one
 * group (a tier per video quality) offers every language once per group; renditions sharing a
 * `LANGUAGE` are the same track, and ExoPlayer moves between them as the variant changes. A
 * rendition with no language is a track of its own, keyed by its label. The [id] is the first
 * rendition's, so the same master gives the same ids after a reattach.
 */
class AudioChoice(val id: String, val language: String?, val label: String, val first: AudioRef, val members: List<AudioRef>) {
    /** Whether ExoPlayer is playing any rendition of this track. */
    val selected: Boolean get() = members.any { it.group.isTrackSelected(it.index) }
}

/** One choice per distinct language (else label), in the order they first appear; unplayable renditions are left out. */
fun audioChoicesOf(tracks: Tracks): List<AudioChoice> {
    val byKey = LinkedHashMap<String, MutableList<AudioRef>>()
    for (ref in audioTracksOf(tracks)) {
        if (!ref.group.isTrackSupported(ref.index)) continue
        val format = ref.group.getTrackFormat(ref.index)
        val key = format.language?.takeIf { it.isNotEmpty() }?.let { "lang:$it" } ?: "name:${format.label ?: ref.id}"
        byKey.getOrPut(key) { mutableListOf() } += ref
    }
    return byKey.values.map { members ->
        val first = members.first()
        val format = first.group.getTrackFormat(first.index)
        val language = format.language?.takeIf { it.isNotEmpty() }
        AudioChoice(first.id, language, format.label ?: language ?: first.id, first, members)
    }
}

/**
 * Plays [choice]. A language is asked for as a preference, which ExoPlayer applies to every audio
 * group and so keeps across variant switches; a track with no language is pinned.
 */
fun selectAudio(player: Player, choice: AudioChoice) {
    val builder = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_AUDIO)
    if (choice.language != null) {
        builder.setPreferredAudioLanguage(choice.language)
    } else {
        builder.setPreferredAudioLanguage(null)
        builder.setOverrideForType(TrackSelectionOverride(choice.first.group.mediaTrackGroup, choice.first.index))
    }
    player.trackSelectionParameters = builder.build()
}
