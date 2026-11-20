import {
    ANGLE_ACCESSIBILITY,
    type AngleAccessibility,
} from '@luminary-media-converter/hls-core';
import type {
    EncodeConfigDto,
    VideoRenditionDto,
    VideoTrackNameDto,
} from '../dto/encode-config.dto.js';
import { assertAngleLanguage } from '../../hls-edit/video-angles.js';

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
    /**
     * `LANGUAGE`: the audio language the picture belongs to (burnt-in titles,
     * lip sync), which a player follows the audio to. Absent when it has none.
     */
    language?: string;
    /** The hearing-impaired kind of view, written as `CHARACTERISTICS`. Absent for none. */
    accessibility?: AngleAccessibility;
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
 *
 * An angle's language and kind of view come from its `videoTrackNames` entry
 * too, the language spelled as the published-video editor writes it
 * ({@link assertAngleLanguage}): the two write one master between them, and a
 * player reads both. Empty means none, and none is left off the angle rather
 * than set empty. An index listed twice takes its name, language and kind all
 * from one entry, the last that has a name (else the last), so no angle is
 * given one entry's name and another's language.
 *
 * This never throws. It runs when the master is fixed up at the end of an
 * encode, where a throw would lose the finished encode; a language or kind
 * that is not one (the request was checked when the encode started) is left
 * off the angle instead.
 */
export function outputAngles(config: EncodeConfigDto): OutputAngle[] {
    const used: number[] = [];
    for (const r of config.videoRenditions ?? []) {
        const id = angleOf(r);
        if (!used.includes(id)) used.push(id);
    }
    if (used.length <= 1) return [];

    const entries = new Map<number, VideoTrackNameDto>();
    const listed: number[] = [];
    for (const tn of config.videoTrackNames ?? []) {
        if (!listed.includes(tn.index)) listed.push(tn.index);
        if (tn.name?.trim() || !entries.get(tn.index)?.name?.trim()) {
            entries.set(tn.index, tn);
        }
    }
    const rank = (id: number) => {
        const at = listed.indexOf(id);
        return at < 0 ? listed.length + used.indexOf(id) : at;
    };
    const order = [...used].sort((a, b) => rank(a) - rank(b));

    const taken = new Set<string>();
    return order.map((id) => {
        const entry = entries.get(id);
        const name = entry?.name?.trim() || `Angle ${id}`;
        const base = sanitizeGroupId(name);
        let groupId = base;
        for (let n = 2; taken.has(groupId); n++) groupId = `${base}_${n}`;
        taken.add(groupId);
        const language = angleLanguage(entry?.language);
        const accessibility = isAccessibility(entry?.accessibility)
            ? entry.accessibility
            : undefined;
        return {
            id,
            name,
            groupId,
            ...(language ? { language } : {}),
            ...(accessibility ? { accessibility } : {}),
        };
    });
}

/** `language` as an angle's `LANGUAGE` is written, or empty when it is not a language code. */
function angleLanguage(language: unknown): string {
    if (typeof language !== 'string') return '';
    try {
        return assertAngleLanguage(language);
    } catch {
        return '';
    }
}

/** One of the kinds {@link ANGLE_ACCESSIBILITY} knows how to write. */
function isAccessibility(kind: unknown): kind is AngleAccessibility {
    return typeof kind === 'string' && Object.hasOwn(ANGLE_ACCESSIBILITY, kind);
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

/**
 * The `#EXT-X-MEDIA:TYPE=VIDEO` line for one angle, its attributes in the
 * order the published-video editor writes a new angle's line in: `TYPE`,
 * `GROUP-ID`, `NAME`, `LANGUAGE`, `CHARACTERISTICS`, `DEFAULT`, leaving out
 * what the angle does not have, and a kind it does not know. An untagged
 * angle's line is the one this has always written. A line break in the name
 * becomes a space: it would end the line, stranding what follows it.
 */
export function videoMediaLine(angle: OutputAngle, isDefault: boolean): string {
    const name = angle.name.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
    return (
        `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${angle.groupId}",` +
        `NAME="${name}"` +
        (angle.language ? `,LANGUAGE="${angle.language}"` : '') +
        (isAccessibility(angle.accessibility)
            ? `,CHARACTERISTICS="${ANGLE_ACCESSIBILITY[angle.accessibility]}"`
            : '') +
        `,DEFAULT=${isDefault ? 'YES' : 'NO'}`
    );
}
