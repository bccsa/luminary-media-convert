package org.bccsa.luminary.player.engine

import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks

/** One video quality the viewer can hold the picture to: the tier's height, and whether it is the one held. */
class QualityChoice(val height: Int, val selected: Boolean)

/**
 * The tiers of the video's ladder, tallest first, one each however many bitrates share a height. Empty
 * while the ladder is unknown, and with one tier there is nothing to choose, so the setting is left out.
 */
fun qualityChoicesOf(tracks: Tracks, held: Int?): List<QualityChoice> {
    val heights = sortedSetOf<Int>(compareByDescending { it })
    for (group in tracks.groups) {
        if (group.type != C.TRACK_TYPE_VIDEO) continue
        for (i in 0 until group.length) {
            val height = group.getTrackFormat(i).height
            if (group.isTrackSupported(i) && height > 0) heights += height
        }
    }
    return heights.map { QualityChoice(it, it == held) }
}

/** The height the viewer holds the picture to, or null while ExoPlayer chooses (auto). */
fun heldQuality(player: Player): Int? {
    val override = player.trackSelectionParameters.overrides.values.firstOrNull { it.type == C.TRACK_TYPE_VIDEO } ?: return null
    val group = player.currentTracks.groups.firstOrNull { it.mediaTrackGroup == override.mediaTrackGroup } ?: return null
    return override.trackIndices.firstOrNull()?.let { group.getTrackFormat(it).height }?.takeIf { it > 0 }
}

/** Holds the picture to [height], or hands the choice back to ExoPlayer when null (auto). */
fun selectQuality(player: Player, height: Int?) {
    val builder = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_VIDEO)
    if (height != null) {
        for (group in player.currentTracks.groups) {
            if (group.type != C.TRACK_TYPE_VIDEO) continue
            val indices = (0 until group.length).filter { group.getTrackFormat(it).height == height && group.isTrackSupported(it) }
            if (indices.isNotEmpty()) {
                builder.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, indices))
                break
            }
        }
    }
    player.trackSelectionParameters = builder.build()
}
