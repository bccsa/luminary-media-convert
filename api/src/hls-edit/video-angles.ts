import { BadRequestException } from '@nestjs/common';
import {
    parseMasterPlaylist,
    type HlsParsedMaster,
} from '@luminary-media-converter/hls-core';
import {
    MEDIA_TAG,
    attributePattern,
    readAttribute,
    writeAttribute,
    writeBareAttribute,
} from './audio-tracks.js';

/**
 * A camera angle as a viewer picks it: one `TYPE=VIDEO` rendition group and
 * the variants that name it. A video with a single picture has no such group;
 * it is listed as one angle with an empty `id`, unnamed until a second angle
 * is added.
 */
export interface VideoAngle {
    /** `GROUP-ID`; empty for the single picture of a video without angles. */
    id: string;
    /** `NAME`; empty for that single picture. */
    name: string;
    default: boolean;
    /** How many variants (sizes) the angle has. */
    renditions: number;
}

/** A new name for an angle. */
export interface VideoAngleEdit {
    id: string;
    name: string;
}

/** A variant of a new angle, and the existing one it stands beside. */
export interface AddedAngleVariant {
    /** The URI of the existing variant whose attributes (audio, subtitles) it takes. */
    referenceUri: string;
    /** Its media playlist, relative to the master. */
    uri: string;
    bandwidth: number;
    averageBandwidth?: number;
    /** `WIDTHxHEIGHT`. */
    resolution: string;
    frameRate?: number;
    codecs: string;
}

const STREAM_INF = '#EXT-X-STREAM-INF:';
const IFRAME_INF = '#EXT-X-I-FRAME-STREAM-INF:';
const NAME_FORBIDDEN = /["\r\n]/;
const NAME_MAX = 100;

/** An angle's name, trimmed, or a 400 saying what is wrong with it. */
export function assertAngleName(name: string): string {
    const label = (name ?? '').trim();
    if (!label || label.length > NAME_MAX || NAME_FORBIDDEN.test(label)) {
        throw new BadRequestException(
            `An angle name needs 1 to ${NAME_MAX} characters, without quotes or line breaks`
        );
    }
    return label;
}

/** The master's camera angles, in the order their groups appear. */
export function listVideoAngles(master: HlsParsedMaster): VideoAngle[] {
    const groups = master.media.filter((m) => m.type === 'VIDEO');
    if (groups.length === 0) {
        const pictured = master.variants.filter(isPictured);
        return pictured.length > 0
            ? [
                  {
                      id: '',
                      name: '',
                      default: true,
                      renditions: pictured.length,
                  },
              ]
            : [];
    }
    const seen = new Set<string>();
    const angles: VideoAngle[] = [];
    for (const group of groups) {
        if (seen.has(group.groupId)) continue;
        seen.add(group.groupId);
        angles.push({
            id: group.groupId,
            name: group.name,
            default: group.default === true,
            renditions: master.variants.filter(
                (v) => v.videoGroup === group.groupId
            ).length,
        });
    }
    if (!angles.some((a) => a.default) && angles[0]) angles[0].default = true;
    return angles;
}

/** A variant with a picture: an audio-only one states neither a size nor a video codec. */
function isPictured(v: HlsParsedMaster['variants'][number]): boolean {
    return (
        !!v.resolution ||
        /(^|,)\s*(avc1|avc3|hvc1|hev1|av01|vp09)/.test(v.codecs ?? '')
    );
}

/**
 * A group id for an angle named `name`, as the encoder derives its own, made
 * unique among `taken` (which it joins).
 */
export function angleGroupId(name: string, taken: Set<string>): string {
    const base =
        name
            .replace(/[^a-zA-Z0-9_-]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '') || 'angle';
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    return id;
}

const sameName = (a: string, b: string): boolean =>
    a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * `text`, a master playlist, with a camera angle added: its `TYPE=VIDEO` group
 * and one variant per entry of `variants`, each taking every other attribute
 * (audio, subtitles, captions) from the existing variant it stands beside. The
 * new angle is never the default.
 *
 * A video with a single picture gains angles here: that picture becomes the
 * default angle, named `mainName`, and every existing variant and I-frame
 * playlist names it. Every other byte is left as it was.
 *
 * Throws, rewriting nothing, when a name is invalid or already an angle's, the
 * video has no picture, or a reference variant is not in the master.
 */
export function addVideoAngleLines(
    text: string,
    names: { name: string; mainName?: string },
    variants: AddedAngleVariant[]
): string {
    const name = assertAngleName(names.name);
    const master = parseMasterPlaylist(text);
    const angles = listVideoAngles(master);
    if (angles.length === 0) {
        throw new BadRequestException(
            'This video has no picture to add an angle beside'
        );
    }
    const single = angles[0].id === '';
    const mainName = single ? assertAngleName(names.mainName ?? 'Main') : '';
    if (
        single
            ? sameName(mainName, name)
            : angles.some((a) => sameName(a.name, name))
    ) {
        throw new BadRequestException(
            `The video already has an angle "${name}"`
        );
    }
    if (variants.length === 0) {
        throw new BadRequestException('A new angle needs at least one variant');
    }

    const taken = new Set(master.media.map((m) => m.groupId));
    const mainId = single ? angleGroupId(mainName, taken) : '';
    const newId = angleGroupId(name, taken);

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    if (single) {
        for (let i = 0; i < lines.length; i++) {
            for (const tag of [STREAM_INF, IFRAME_INF]) {
                if (lines[i].startsWith(tag)) {
                    lines[i] =
                        tag +
                        writeAttribute(
                            lines[i].slice(tag.length),
                            'VIDEO',
                            mainId
                        );
                }
            }
        }
    }

    // Each new variant, from the existing one it stands beside.
    const added: string[] = [];
    for (const variant of variants) {
        const at = streamInfIndexOf(lines, variant.referenceUri);
        if (at < 0) {
            throw new BadRequestException(
                `The video has no variant "${variant.referenceUri}"`
            );
        }
        let attrs = lines[at].slice(STREAM_INF.length);
        attrs = writeBareAttribute(
            attrs,
            'BANDWIDTH',
            String(variant.bandwidth)
        );
        attrs =
            variant.averageBandwidth !== undefined
                ? writeBareAttribute(
                      attrs,
                      'AVERAGE-BANDWIDTH',
                      String(variant.averageBandwidth)
                  )
                : removeAttribute(attrs, 'AVERAGE-BANDWIDTH');
        attrs = writeBareAttribute(attrs, 'RESOLUTION', variant.resolution);
        attrs =
            variant.frameRate !== undefined
                ? writeBareAttribute(
                      attrs,
                      'FRAME-RATE',
                      variant.frameRate.toFixed(3)
                  )
                : removeAttribute(attrs, 'FRAME-RATE');
        attrs = writeAttribute(attrs, 'CODECS', variant.codecs);
        attrs = writeAttribute(attrs, 'VIDEO', newId);
        added.push(STREAM_INF + attrs, variant.uri);
    }

    const mediaLines = [
        ...(single
            ? [
                  `${MEDIA_TAG}TYPE=VIDEO,GROUP-ID="${mainId}",NAME="${mainName}",DEFAULT=YES`,
              ]
            : []),
        `${MEDIA_TAG}TYPE=VIDEO,GROUP-ID="${newId}",NAME="${name}",DEFAULT=NO`,
    ];

    // The variants go after the last one, the group after the last of its kind.
    let afterVariants = lastIndex(lines, (l) => l.startsWith(STREAM_INF)) + 1;
    while (afterVariants < lines.length && isTagOrBlank(lines[afterVariants]))
        afterVariants++;
    lines.splice(afterVariants + 1, 0, ...added);
    const lastVideoMedia = lastIndex(
        lines,
        (l) =>
            l.startsWith(MEDIA_TAG) &&
            readAttribute(l.slice(MEDIA_TAG.length), 'TYPE') === 'VIDEO'
    );
    const lastMedia = lastIndex(lines, (l) => l.startsWith(MEDIA_TAG));
    const firstVariant = lines.findIndex((l) => l.startsWith(STREAM_INF));
    const mediaAt =
        lastVideoMedia >= 0
            ? lastVideoMedia + 1
            : lastMedia >= 0
              ? lastMedia + 1
              : firstVariant;
    lines.splice(mediaAt, 0, ...mediaLines);
    return lines.join(eol);
}

/**
 * Renames camera angles and takes the `removed` ones out of the master: their
 * group, their variants and their I-frame playlists. Their files stay in
 * storage. When the default angle goes, the first one left becomes it.
 *
 * Checked first, so nothing is rewritten when an angle is unknown, both
 * renamed and removed, would be the last one taken out, or a name is invalid
 * or would be two angles'.
 */
export function rewriteVideoAngles(
    text: string,
    edits: VideoAngleEdit[],
    removed: string[] = []
): string {
    const master = parseMasterPlaylist(text);
    const angles = listVideoAngles(master).filter((a) => a.id !== '');
    const known = new Set(angles.map((a) => a.id));
    for (const id of [...edits.map((e) => e.id), ...removed]) {
        if (!known.has(id)) {
            throw new BadRequestException(`No angle "${id}"`);
        }
    }
    const gone = new Set(removed);
    if (edits.some((e) => gone.has(e.id))) {
        throw new BadRequestException(
            'An angle cannot be both renamed and removed'
        );
    }
    const kept = angles.filter((a) => !gone.has(a.id));
    if (kept.length === 0) {
        throw new BadRequestException('A video keeps at least one angle');
    }
    const names = new Map(
        edits.map((e) => [e.id, assertAngleName(e.name)] as const)
    );
    const finalNames = kept.map((a) => names.get(a.id) ?? a.name);
    if (
        finalNames.some((n, i) =>
            finalNames.some((m, j) => j < i && sameName(n, m))
        )
    ) {
        throw new BadRequestException('Two angles cannot have the same name');
    }

    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    const out: string[] = [];
    let lostDefault = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith(MEDIA_TAG)) {
            const attrs = line.slice(MEDIA_TAG.length);
            const id = readAttribute(attrs, 'GROUP-ID') ?? '';
            if (readAttribute(attrs, 'TYPE') === 'VIDEO') {
                if (gone.has(id)) {
                    lostDefault ||= readAttribute(attrs, 'DEFAULT') === 'YES';
                    continue;
                }
                const to = names.get(id);
                if (to) {
                    out.push(MEDIA_TAG + writeAttribute(attrs, 'NAME', to));
                    continue;
                }
            }
        } else if (line.startsWith(STREAM_INF)) {
            const id = readAttribute(line.slice(STREAM_INF.length), 'VIDEO');
            if (id && gone.has(id)) {
                // Its URI goes with it: the next line that is not a tag.
                while (i + 1 < lines.length && isTagOrBlank(lines[i + 1])) {
                    out.push(lines[++i]);
                }
                i++;
                continue;
            }
        } else if (line.startsWith(IFRAME_INF)) {
            const id = readAttribute(line.slice(IFRAME_INF.length), 'VIDEO');
            if (id && gone.has(id)) continue;
        }
        out.push(line);
    }
    if (lostDefault) {
        const first = out.findIndex(
            (l) =>
                l.startsWith(MEDIA_TAG) &&
                readAttribute(l.slice(MEDIA_TAG.length), 'TYPE') === 'VIDEO'
        );
        if (first >= 0) {
            out[first] =
                MEDIA_TAG +
                writeBareAttribute(
                    out[first].slice(MEDIA_TAG.length),
                    'DEFAULT',
                    'YES'
                );
        }
    }
    return out.join(eol);
}

/** The line of the `EXT-X-STREAM-INF` whose URI is `uri`, or -1. */
function streamInfIndexOf(lines: string[], uri: string): number {
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith(STREAM_INF)) continue;
        let j = i + 1;
        while (j < lines.length && isTagOrBlank(lines[j])) j++;
        if (lines[j]?.trim() === uri) return i;
    }
    return -1;
}

const isTagOrBlank = (line: string): boolean =>
    line.trim() === '' || line.startsWith('#');

function lastIndex(lines: string[], test: (line: string) => boolean): number {
    for (let i = lines.length - 1; i >= 0; i--) if (test(lines[i])) return i;
    return -1;
}

function removeAttribute(list: string, name: string): string {
    return list.replace(attributePattern(name), '').replace(/^,/, '');
}
