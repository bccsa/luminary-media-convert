import type { AudioTrackInfo, VideoTrackInfo } from './types';

export interface SavedTrackLabels {
    videoTrackNames?: { index: number; name: string }[];
    audioTrackMetadata?: { index: number; name?: string; language?: string }[];
}

/**
 * Apply previously saved track labels to the detected tracks.
 *
 * `overwrite` separates two situations that want opposite behaviour:
 *
 * - **false**, applied automatically on mount. Saved labels fill in what the
 *   source left blank and nothing more. Applied unconditionally it destroyed
 *   real metadata: a broadcast naming its tracks `CH_0_MUL`, `CH_1_ENG`,
 *   `CH_2_FRA`, `CH_3_NYA`, `CH_4_SWA` was displayed as one `English` and four
 *   `NA`, because someone had once typed that against the same layout. The form
 *   then showed less than the file carried, with no way to recover it — and the
 *   collapsed names left every downstream suggestion with nothing to work from.
 * - **true**, when the user presses "Load saved track labels". That is an
 *   explicit request for the saved set, so it replaces what is there.
 */
export function applySavedTrackLabels(
    saved: SavedTrackLabels,
    videoTracks: VideoTrackInfo[],
    audioTracks: AudioTrackInfo[],
    overwrite: boolean
): void {
    if (saved.videoTrackNames) {
        const names = new Map(saved.videoTrackNames.map((t) => [t.index, t.name]));
        for (const track of videoTracks) {
            const label = names.get(track.index);
            if (label == null) continue;
            if (overwrite || !track.name) track.name = label;
        }
    }

    if (saved.audioTrackMetadata) {
        const meta = new Map(
            saved.audioTrackMetadata.map((m) => [
                m.index,
                { name: m.name, language: m.language },
            ])
        );
        for (const track of audioTracks) {
            const label = meta.get(track.index);
            if (!label) continue;
            if (label.name !== undefined && (overwrite || !track.name)) {
                track.name = label.name;
            }
            if (label.language !== undefined && (overwrite || !track.language)) {
                track.language = label.language;
            }
        }
    }
}
