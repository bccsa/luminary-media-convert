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
    const given = (angle: Angle) =>
        angle.members.find((t) => t.index === angle.id)?.name?.trim() ||
        angle.members.map((t) => t.name?.trim()).find(Boolean);
    for (const angle of angles) {
        const name = given(angle);
        if (name) claim(angle.id, name);
    }
    angles.forEach((angle, n) => {
        if (!names.has(angle.id)) claim(angle.id, `Angle ${n}`);
    });
    return names;
}
