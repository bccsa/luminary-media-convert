/**
 * Matching an audio track to the language a host asked for.
 *
 * Ported from the Luminary app's `audioTrackLanguage.ts`, and it exists because
 * browsers do not agree on how a track's language is spelled: iOS Safari
 * reports the ISO-639-1 two-letter code (`en`), Android Chrome reports the
 * three-letter ISO-639-2 one — and there are two of those, the terminological
 * (`deu`) and the bibliographic (`ger`), with no rule about which a device
 * picks. Comparing strings gets the right answer on one platform and the wrong
 * one on the other, which is why this is a function and not `===`.
 *
 * Pure: no DOM, no video.js. The player calls it, tests call it directly.
 */
import { iso6392BTo1, iso6392TTo1 } from 'iso-639-2';

/** Lower-cases and drops any region suffix: `en-US` → `en`, `ENG` → `eng`. */
function normalize(value: string): string {
    return value.trim().toLowerCase().split('-')[0] ?? '';
}

/**
 * The one spelling a language is compared under: its two-letter ISO-639-1 code
 * where it has one, and the normalized input where it does not.
 *
 * Both three-letter sets collapse to the same answer, which is the point: `ger`
 * and `deu` are the bibliographic and terminological codes for German, and
 * nothing outside this function should ever have to know that. A language with
 * no two-letter code (`fil`, `haw`) is left as it is and still matches itself.
 */
function canonical(value: string): string {
    const code = normalize(value);
    return iso6392TTo1[code] ?? iso6392BTo1[code] ?? code;
}

/**
 * Whether a track's declared language is the one the host asked for.
 *
 * Either side may arrive two-letter, three-letter terminological or three-letter
 * bibliographic, and which one shows up is the browser's and the host's business
 * respectively — so *both* are canonicalized and the canonical forms compared.
 * Mapping only the track's code, as an earlier version did, silently failed
 * every host that asked for `eng` or `ger`, and failed `ger` against a `deu`
 * track even though they name one language.
 *
 * An empty or missing value on either side is never a match — "unknown" is not
 * a language, and treating it as one would enable a silent wrong track.
 */
export function matchesPreferredLanguage(
    trackLang: string | null | undefined,
    preferred: string | null | undefined,
): boolean {
    if (!trackLang || !preferred) return false;

    const track = canonical(trackLang);
    const target = canonical(preferred);
    if (!track || !target) return false;

    return track === target;
}

/** The minimum a track has to carry for this module to have an opinion on it. */
export interface LanguageTaggedTrack {
    id: string;
    lang?: string;
}

/**
 * The id of the first track whose language matches `preferred`, or null.
 *
 * First rather than best: a stream carrying two tracks of one language has
 * already made that a labelling problem, and picking between them by any rule
 * this module could invent would be guessing. Null means "leave the selection
 * alone" — never "select nothing", which would mute the video.
 */
export function findPreferredTrack(
    tracks: readonly LanguageTaggedTrack[],
    preferred: string | null | undefined,
): string | null {
    if (!preferred) return null;
    for (const track of tracks) {
        if (matchesPreferredLanguage(track.lang, preferred)) return track.id;
    }
    return null;
}
