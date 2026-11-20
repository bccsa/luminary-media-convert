import type {
    AngleAccessibility,
    AudioTrackInfo,
    VideoTrackInfo,
    VideoTrackName,
} from './types';

export interface SavedTrackLabels {
    videoTrackNames?: VideoTrackName[];
    audioTrackMetadata?: { index: number; name?: string; language?: string }[];
}

/**
 * An angle's language and kind of view, filed by track, as its name is kept on
 * a track. Only what is set: no empty language, no `none`.
 */
export type AngleTags = Pick<VideoTrackName, 'language' | 'accessibility'>;

const ACCESSIBILITY_KINDS: readonly string[] = [
    'captions',
    'sign-language',
    'lip-reading',
] satisfies AngleAccessibility[];

/**
 * The language and kind of view a saved entry really has. Storage is not
 * trusted: an entry written by an older or other build, or edited by hand, may
 * carry a kind this one does not know or a language that is not text, and
 * either would go on to the encode as it is.
 */
function savedTags(entry: VideoTrackName): AngleTags {
    const language =
        typeof entry.language === 'string' ? entry.language.trim() : '';
    const kind = entry.accessibility;
    return {
        ...(language ? { language } : {}),
        ...(typeof kind === 'string' && ACCESSIBILITY_KINDS.includes(kind)
            ? { accessibility: kind }
            : {}),
    };
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
 *
 * An angle's language and kind of view travel with its name into `angleTags`
 * when the caller keeps them, as a pair: with `overwrite` the saved two replace
 * the angle's (one the entry does not have is cleared, so no mix of the
 * operator's and the saved set appears that nobody saved); without it they
 * only fill what is blank.
 */
export function applySavedTrackLabels(
    saved: SavedTrackLabels,
    videoTracks: VideoTrackInfo[],
    audioTracks: AudioTrackInfo[],
    overwrite: boolean,
    angleTags?: Map<number, AngleTags>
): void {
    if (saved.videoTrackNames) {
        const entries = new Map(saved.videoTrackNames.map((t) => [t.index, t]));
        for (const track of videoTracks) {
            const entry = entries.get(track.index);
            if (entry == null) continue;
            if (entry.name != null && (overwrite || !track.name)) {
                track.name = entry.name;
            }
            if (!angleTags) continue;
            const stored = savedTags(entry);
            const current = angleTags.get(track.index) ?? {};
            const language = overwrite
                ? stored.language
                : current.language || stored.language;
            const accessibility = overwrite
                ? stored.accessibility
                : current.accessibility || stored.accessibility;
            if (language || accessibility) {
                angleTags.set(track.index, {
                    ...(language ? { language } : {}),
                    ...(accessibility ? { accessibility } : {}),
                });
            } else {
                angleTags.delete(track.index);
            }
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
