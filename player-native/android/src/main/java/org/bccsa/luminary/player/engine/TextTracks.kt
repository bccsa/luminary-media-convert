package org.bccsa.luminary.player.engine

import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks

/** One subtitle the master lists (`TYPE=SUBTITLES`), and where it sits in ExoPlayer's track groups. */
class SubtitleChoice(val label: String, val language: String?, val group: Tracks.Group, val index: Int) {
    val selected: Boolean get() = group.isTrackSelected(index)
}

/** Every playable subtitle, in the master's order, named as its master names it (NAME, else LANGUAGE). */
fun subtitleChoicesOf(tracks: Tracks): List<SubtitleChoice> = buildList {
    for (group in tracks.groups) {
        if (group.type != C.TRACK_TYPE_TEXT) continue
        for (i in 0 until group.length) {
            if (!group.isTrackSupported(i)) continue
            val format = group.getTrackFormat(i)
            val language = format.language?.takeIf { it.isNotEmpty() }
            add(SubtitleChoice(format.label ?: language ?: "Subtitles ${size + 1}", language, group, i))
        }
    }
}

/** Shows [choice]; null turns the subtitles off. */
fun selectSubtitle(player: Player, choice: SubtitleChoice?) {
    val builder = player.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
    player.trackSelectionParameters = if (choice == null) {
        builder.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
    } else {
        builder
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
            .setOverrideForType(TrackSelectionOverride(choice.group.mediaTrackGroup, choice.index))
            .build()
    }
}

/**
 * The page's `setSubtitleTrack`: the subtitle listed under [label] (its name, else its language),
 * or none for null. A label no subtitle carries changes nothing.
 */
fun selectSubtitle(player: Player, label: String?) {
    if (label == null) return selectSubtitle(player, null as SubtitleChoice?)
    val options = subtitleChoicesOf(player.currentTracks)
    val match = options.firstOrNull { it.label == label } ?: options.firstOrNull { it.language == label } ?: return
    selectSubtitle(player, match)
}
