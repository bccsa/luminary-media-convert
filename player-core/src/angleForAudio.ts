/**
 * Which camera angle goes with an audio language.
 *
 * A video can carry a different picture per language — burnt-in titles, a
 * presenter lip-synced to the dub — and a picture made for a hearing-impaired
 * viewer: captions, sign language, lip reading. The master says which by the
 * `LANGUAGE` and `CHARACTERISTICS` on each angle's `TYPE=VIDEO` line (see
 * {@link Angle.lang} and {@link Angle.characteristics}).
 *
 * Pure, like `audioTrackLanguage.ts` beside it: the controller asks it at load
 * time, to start on the right picture, and when the viewer changes the audio
 * language, to follow it. Not exported from the package: what it decides is
 * the controller's behaviour, and that is the contract.
 */
import { matchesPreferredLanguage } from './audioTrackLanguage.js';
import { AUDIO_ONLY_ANGLE_ID, type Angle } from './types.js';

/**
 * The id of the angle to show with audio in `lang`, given the angle playing;
 * undefined when no angle is for that language — the caller then leaves the
 * picture where it is.
 *
 * A candidate is tagged with the language (either side may be two- or
 * three-letter) AND is the same kind of view as `playing`: its characteristics
 * are the same set, in any order. Same kind rather than any kind, because a
 * viewer on the sign-language picture who changes the audio still needs the
 * signing — moving them to the French titles would take away the one picture
 * they can follow. `playing` undefined (the start of a load) or untagged asks
 * for a plain picture: one with no characteristics. An angle with no language
 * is never a candidate, so a sign-language view that belongs to no spoken
 * language is never jumped to, and an untagged master never moves at all.
 *
 * Among candidates, `playing` itself when it is one — two cameras of the same
 * language are both right, and the one the viewer is watching is the one they
 * chose — else the master's default, else the first.
 */
export function angleForAudio(
    angles: readonly Angle[],
    playing: Angle | undefined,
    lang: string | null | undefined,
): string | undefined {
    if (!lang) return undefined;
    const kind = new Set(playing?.characteristics ?? []);
    const candidates = angles.filter(
        (angle) =>
            angle.id !== AUDIO_ONLY_ANGLE_ID &&
            matchesPreferredLanguage(angle.lang, lang) &&
            sameSet(angle.characteristics ?? [], kind),
    );
    if (candidates.length === 0) return undefined;
    if (playing && candidates.some((angle) => angle.id === playing.id))
        return playing.id;
    return (candidates.find((angle) => angle.isDefault) ?? candidates[0])!.id;
}

/** Whether `list`, read as a set, holds exactly the members of `set`. */
function sameSet(list: readonly string[], set: ReadonlySet<string>): boolean {
    const own = new Set(list);
    if (own.size !== set.size) return false;
    for (const member of own) if (!set.has(member)) return false;
    return true;
}
