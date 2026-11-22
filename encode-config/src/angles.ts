import type { VideoTrackInfo } from './types';
import { displayDimensionsOf } from './aspect';

/**
 * Camera angles: which source tracks are one picture.
 *
 * The probe compares frames and says which tracks show the same picture
 * (`pictureGroup`); the operator can then move a track to another angle. This
 * module holds that assignment's rules — how angles are keyed, ordered and
 * named, and which member a ladder is re-encoded from — so the form only asks.
 *
 * An angle's id is its lowest member's track index. Only an identifier: it is
 * what `angle` on a rendition and `index` on a `videoTrackNames` entry name, and
 * the API bounds it like a track index. Which member is *best* is a ranking,
 * answered by {@link rankTracks}, and can differ from it.
 */

/** Track index → angle id. */
export type AngleAssignment = Map<number, number>;

export interface Angle {
    id: number;
    /** Every member, best first. */
    members: VideoTrackInfo[];
    /** The members still included in the encode, best first. */
    included: VideoTrackInfo[];
    /** The best included member: what a re-encoded ladder is made from. */
    best: VideoTrackInfo;
}

/**
 * Best first: the most picture (display area), then the most bits, then the
 * lower index. Display area rather than coded area, so an anamorphic master is
 * not ranked below a square-pixel proxy of the same picture.
 */
export function rankTracks(a: VideoTrackInfo, b: VideoTrackInfo): number {
    const da = displayDimensionsOf(a);
    const db = displayDimensionsOf(b);
    const area = db.width * db.height - da.width * da.height;
    if (area !== 0) return area;
    const bits = (b.bitrateKbps || 0) - (a.bitrateKbps || 0);
    if (bits !== 0) return bits;
    return a.index - b.index;
}

/** The probe's grouping: every track in its `pictureGroup`, else on its own. */
export function initialAssignment(
    tracks: readonly VideoTrackInfo[]
): AngleAssignment {
    return normalize(new Map(tracks.map((t) => [t.index, t.pictureGroup ?? t.index])));
}

/**
 * Re-key every angle by its lowest member, so ids stay track indices however
 * tracks have been moved between angles.
 */
export function normalize(assignment: AngleAssignment): AngleAssignment {
    const lowest = new Map<number, number>();
    for (const [track, key] of assignment) {
        lowest.set(key, Math.min(lowest.get(key) ?? Infinity, track));
    }
    return new Map(
        [...assignment].map(([track, key]) => [track, lowest.get(key)!])
    );
}

/**
 * Move `track` into angle `target`, or into an angle of its own for `'new'`.
 * Returns the new, normalized assignment.
 */
export function moveTrack(
    assignment: AngleAssignment,
    track: number,
    target: number | 'new'
): AngleAssignment {
    const next = new Map(assignment);
    // A key no angle uses, so the track stands alone until normalized.
    next.set(track, target === 'new' ? -1 - track : target);
    return normalize(next);
}

/**
 * The angles the assignment makes, ordered by id — the order the default angle
 * has always been chosen in, track 0's first. Angles with nothing included are
 * left out when `includedOnly`, as the encode would leave them out.
 */
export function anglesOf(
    tracks: readonly VideoTrackInfo[],
    assignment: AngleAssignment,
    excluded: ReadonlySet<number>,
    includedOnly = true
): Angle[] {
    const byId = new Map<number, VideoTrackInfo[]>();
    for (const t of tracks) {
        const id = assignment.get(t.index) ?? t.index;
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id)!.push(t);
    }
    const angles: Angle[] = [];
    for (const id of [...byId.keys()].sort((a, b) => a - b)) {
        const members = [...byId.get(id)!].sort(rankTracks);
        const included = members.filter((t) => !excluded.has(t.index));
        if (includedOnly && included.length === 0) continue;
        angles.push({ id, members, included, best: included[0] ?? members[0] });
    }
    return angles;
}

/**
 * Bitrates this close, as a share of the larger, count as the same encoding.
 */
const ALIKE_BITRATE_SHARE = 0.15;

/**
 * Same size, codec, frame rate and, within {@link ALIKE_BITRATE_SHARE},
 * bitrate: the mark of one recorder's camera tracks. A source's own ladder
 * steps down in size or bitrate from rung to rung, so its rungs never are.
 * Where either bitrate is unknown, nothing is left to tell two tracks of one
 * size apart, and they count as alike too.
 */
function encodedAlike(a: VideoTrackInfo, b: VideoTrackInfo): boolean {
    const da = displayDimensionsOf(a);
    const db = displayDimensionsOf(b);
    if (da.width !== db.width || da.height !== db.height) return false;
    if (a.codec !== b.codec || a.frameRate !== b.frameRate) return false;
    if (!(a.bitrateKbps > 0 && b.bitrateKbps > 0)) return true;
    const larger = Math.max(a.bitrateKbps, b.bitrateKbps);
    return (
        Math.abs(a.bitrateKbps - b.bitrateKbps) / larger <= ALIKE_BITRATE_SHARE
    );
}

/**
 * Why the angle's grouping should be checked by eye before its tracks are
 * copied as one ladder, or null.
 *
 * Detection settles a pair of tracks as two pictures the moment they disagree,
 * but agreement can only ever make one picture likely. Two things leave it
 * less likely than usual: the comparison was cut short by the time allowed,
 * or the tracks are encoded alike — a programme feed and the camera it sits on
 * most of the time, recorded side by side, agree almost everywhere.
 *
 * Only tracks detection put together are asked about. Ones the operator moved
 * into an angle are their call.
 */
export function angleDoubt(angle: Angle): string | null {
    const grouped = angle.included.filter((t) => t.pictureGroup != null);
    for (let i = 0; i < grouped.length; i++) {
        for (let j = i + 1; j < grouped.length; j++) {
            const [a, b] = [grouped[i], grouped[j]].sort(
                (x, y) => x.index - y.index
            );
            if (a.pictureGroup !== b.pictureGroup) continue;
            const pair = `#${a.index} and #${b.index}`;
            if (a.pictureVerified === false || b.pictureVerified === false) {
                const matches = Math.min(
                    a.pictureMatches ?? Infinity,
                    b.pictureMatches ?? Infinity
                );
                const counted = Number.isFinite(matches)
                    ? ` (they matched at ${matches})`
                    : '';
                return (
                    `detection ran out of time before it had compared ${pair} ` +
                    `at as many moments as it normally does${counted}, so it ` +
                    `is not sure they show one picture.`
                );
            }
            if (encodedAlike(a, b))
                return (
                    `${pair} showed the same picture, but they are encoded alike ` +
                    `(same size, codec and frame rate, and bitrates close or ` +
                    `unknown), as tracks from one recorder are and the ` +
                    `qualities of a ladder are not.`
                );
        }
    }
    return null;
}

/**
 * The pairs of tracks detection could not decide on, as one sentence each:
 * kept as separate angles because the time allowed ran out before a
 * disagreement between them was re-checked. Only pairs still in separate
 * angles, both included — once the operator has put them together, or left
 * one out, there is nothing left to decide.
 */
export function undecidedPairs(angles: readonly Angle[]): string[] {
    const angleOf = new Map<number, number>();
    for (const angle of angles)
        for (const track of angle.included) angleOf.set(track.index, angle.id);
    const notes: string[] = [];
    for (const angle of angles) {
        for (const track of angle.included) {
            for (const other of track.pictureUndecided ?? []) {
                // Each pair once: both of its tracks list the other.
                if (other <= track.index) continue;
                const otherAngle = angleOf.get(other);
                if (otherAngle == null || otherAngle === angle.id) continue;
                notes.push(
                    `Detection ran out of time before deciding whether ` +
                        `#${track.index} and #${other} show the same picture, ` +
                        `so it kept them as separate angles.`
                );
            }
        }
    }
    return notes;
}

/**
 * The member an angle's name comes from: its own track (its id) if that has a
 * name, else the first member that does; undefined when none has one. What
 * else belongs with the name (a language, a kind of view) is read from the
 * same member, so the two move together when tracks move between angles.
 */
export function nameSourceOf(angle: Angle): VideoTrackInfo | undefined {
    return (
        angle.members.find((t) => t.index === angle.id && t.name?.trim()) ??
        angle.members.find((t) => t.name?.trim())
    );
}

/**
 * Each angle's display name, unique among the angles.
 *
 * The angle's own track (its id) names it if it has a name, else the first
 * member that does, else `Angle <n>`, counting the angles from 0 in the order
 * given. Counted, not the id: where every track is its own angle the two are
 * the same number — the name an unnamed angle has always had — but a source
 * of two cameras with a proxy each has angle ids 0 and 2, and a viewer offered
 * `Angle 0` and `Angle 2` looks for the one in between.
 *
 * A repeat takes a counter: two cameras whose tracks are both titled `Camera`
 * are two angles, and a player offering two identical names offers no way to
 * tell them apart. Names the source or the operator gave are settled first, so
 * a default never takes one of them.
 */
export function angleNames(angles: readonly Angle[]): Map<number, string> {
    const names = new Map<number, string>();
    const taken = new Set<string>();
    const claim = (id: number, base: string) => {
        let name = base;
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
        taken.add(name.toLowerCase());
        names.set(id, name);
    };
    for (const angle of angles) {
        const name = nameSourceOf(angle)?.name?.trim();
        if (name) claim(angle.id, name);
    }
    angles.forEach((angle, n) => {
        if (!names.has(angle.id)) claim(angle.id, `Angle ${n}`);
    });
    return names;
}
