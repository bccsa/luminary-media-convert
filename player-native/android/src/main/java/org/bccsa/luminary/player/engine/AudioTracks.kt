package org.bccsa.luminary.player.engine

import androidx.media3.common.C
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
