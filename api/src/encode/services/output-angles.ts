import type {
    EncodeConfigDto,
    VideoRenditionDto,
} from '../dto/encode-config.dto.js';

/**
 * The camera angles an encode writes, as the master playlist names them.
 *
 * An angle used to be a source track: one track, one `TYPE=VIDEO` group. A
 * copied ladder breaks that — 1080p, 720p and 360p of one picture are three
 * source tracks and one angle — so a rendition now says which angle it belongs
 * to, and everything that groups renditions by angle asks {@link angleOf}
 * rather than reading the track index. What stays per source track (which
 * stream is decoded, mapped, seeked or scanned) keeps reading
 * `sourceTrackIndex`.
 *
 * Shared by the muxer-written master's fix-up and the quick-trim master, which
 * is authored from scratch, so a copied ladder comes out as one angle on either
 * path.
 */

/** The angle a rendition belongs to: its own, else its source track's. */
export function angleOf(rendition: VideoRenditionDto): number {
    return rendition.angle ?? rendition.sourceTrackIndex ?? 0;
}

export interface OutputAngle {
    /** The id renditions name in `angle`. */
    id: number;
    /** `NAME`, as the operator typed it or `Angle <id>`. */
    name: string;
    /** `GROUP-ID`: the name made safe, and unique among the angles. */
    groupId: string;
}

/**
 * Every angle some rendition uses, or an empty list when they all share one — a
 * single picture needs no `TYPE=VIDEO` group at all.
 *
 * Only angles in use: `videoTrackNames` names every track the source has,
 * including ones left out of the encode, and a group with no variant under it
 * is an angle a player offers and cannot play — `DEFAULT=YES` could even land
 * on it. Ordered as `videoTrackNames` lists them, which is the order the
 * default angle has always been chosen by, then any it does not name in the
 * order the renditions first use them. The first angle is the default.
 *
 * Group ids are made unique, because they are derived from names and names
 * repeat: two cameras whose tracks are both titled `Camera` would otherwise
 * collapse into one group carrying both pictures' variants.
 */
export function outputAngles(config: EncodeConfigDto): OutputAngle[] {
    const used: number[] = [];
    for (const r of config.videoRenditions ?? []) {
        const id = angleOf(r);
        if (!used.includes(id)) used.push(id);
    }
    if (used.length <= 1) return [];

    const names = new Map<number, string>();
    const listed: number[] = [];
    for (const tn of config.videoTrackNames ?? []) {
        if (!listed.includes(tn.index)) listed.push(tn.index);
        const name = tn.name?.trim();
        if (name) names.set(tn.index, name);
    }
    const rank = (id: number) => {
        const at = listed.indexOf(id);
        return at < 0 ? listed.length + used.indexOf(id) : at;
    };
    const order = [...used].sort((a, b) => rank(a) - rank(b));

    const taken = new Set<string>();
    return order.map((id) => {
        const name = names.get(id) ?? `Angle ${id}`;
        const base = sanitizeGroupId(name);
        let groupId = base;
        for (let n = 2; taken.has(groupId); n++) groupId = `${base}_${n}`;
        taken.add(groupId);
        return { id, name, groupId };
    });
}

/**
 * The `GROUP-ID` the master gives the angle source video track `trackIndex`
 * belongs to — what the encode's thumbnail strip is labelled with when it was
 * sampled from that track. The angle is that of a rendition made from the
 * track, else the one the form recorded for it (a re-encoded angle has
 * renditions from its best track only). Undefined for an encode without
 * angles, or a track in none of them.
 */
export function angleGroupIdForTrack(
    config: EncodeConfigDto,
    trackIndex: number
): string | undefined {
    const angles = outputAngles(config);
    if (angles.length === 0) return undefined;
    const rendition = (config.videoRenditions ?? []).find(
        (r) => (r.sourceTrackIndex ?? 0) === trackIndex
    );
    const angle = rendition
        ? angleOf(rendition)
        : config.videoTrackAngles?.find((t) => t.index === trackIndex)?.angle;
    return angles.find((a) => a.id === angle)?.groupId;
}

/** A `GROUP-ID` from a name: letters, digits, `_` and `-` only. */
export function sanitizeGroupId(value: string): string {
    return (
        value
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'angle'
    );
}

/** The `#EXT-X-MEDIA:TYPE=VIDEO` line for one angle. */
export function videoMediaLine(angle: OutputAngle, isDefault: boolean): string {
    return (
        `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${angle.groupId}",` +
        `NAME="${angle.name.replace(/"/g, "'")}",DEFAULT=${isDefault ? 'YES' : 'NO'}`
    );
}
