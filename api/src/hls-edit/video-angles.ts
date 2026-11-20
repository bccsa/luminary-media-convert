import { BadRequestException } from '@nestjs/common';
import {
    ANGLE_ACCESSIBILITY,
    angleAccessibilityOf,
    parseMasterPlaylist,
    type AngleAccessibility,
    type HlsParsedMaster,
} from '@luminary-media-converter/hls-core';
import {
    MEDIA_TAG,
    assertLanguage,
    attributePattern,
    readAttribute,
    removeAttribute,
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
    /**
     * `LANGUAGE`: the audio language the picture belongs to (burnt-in titles,
     * lip sync), which a player follows the audio to. Empty when it has none,
     * as an audio track without one reads; always empty for a single picture.
     */
    language: string;
    /**
     * The hearing-impaired kind of view its `CHARACTERISTICS` mark. Absent
     * when they mark none of the kinds in `ANGLE_ACCESSIBILITY`.
     */
    accessibility?: AngleAccessibility;
    default: boolean;
    /** How many variants (sizes) the angle has. */
    renditions: number;
}

/**
 * A change to one angle. A field left out (or null) stays as it is, so an
 * editor sends only what it changed: an empty `language` takes `LANGUAGE`
 * off, and `accessibility: 'none'` takes `CHARACTERISTICS` off when they mark
 * one of our kinds; a value that is none of ours stays as it is.
 */
export interface VideoAngleEdit {
    id: string;
    name?: string;
    language?: string;
    accessibility?: AngleAccessibility | 'none';
}

/** An edit, checked: what each line it names is rewritten to. */
interface AngleChange {
    name?: string;
    language?: string;
    accessibility?: AngleAccessibility | 'none';
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

/**
 * An angle's `LANGUAGE` as it is written: empty for none, else an ISO 639
 * code by the audio tracks' rule, which the angle's language has to match for
 * a player to follow the audio to it. The language part is lower-cased, as
 * that rule spells it; anything else is a 400.
 */
export function assertAngleLanguage(language: string): string {
    const lang = language.trim();
    return lang === ''
        ? ''
        : assertLanguage(lang.replace(/^[A-Za-z]+/, (p) => p.toLowerCase()));
}

const ACCESSIBILITY_KINDS = Object.keys(
    ANGLE_ACCESSIBILITY
) as AngleAccessibility[];

/** One of the hearing-impaired kinds, or `none`; anything else is a 400. */
function angleAccessibility(value: string): AngleAccessibility | 'none' {
    if (value === 'none' || (ACCESSIBILITY_KINDS as string[]).includes(value)) {
        return value as AngleAccessibility | 'none';
    }
    throw new BadRequestException(
        `"${value}" is not a kind of view: use ${ACCESSIBILITY_KINDS.join(', ')} or none`
    );
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
                      language: '',
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
        const accessibility = angleAccessibilityOf(
            group.characteristics?.split(',').map((c) => c.trim())
        );
        angles.push({
            id: group.groupId,
            name: group.name,
            language: group.language ?? '',
            ...(accessibility ? { accessibility } : {}),
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
 * new angle is never the default. Its group line carries its `language` and
 * `accessibility` when it has them.
 *
 * A video with a single picture gains angles here: that picture becomes the
 * default angle, named `mainName` and given `mainLanguage`, and every existing
 * variant and I-frame playlist names it. Every other byte is left as it was.
 *
 * The group lines it writes keep one order, `TYPE`, `GROUP-ID`, `NAME`,
 * `LANGUAGE`, `CHARACTERISTICS`, `DEFAULT`: the order the playlist builder
 * writes, with an attribute the angle does not have left out.
 *
 * Throws, rewriting nothing, when a name or language is invalid, a name is
 * already an angle's, the video has no picture, or a reference variant is not
 * in the master.
 */
export function addVideoAngleLines(
    text: string,
    names: {
        name: string;
        mainName?: string;
        /** The new angle's `LANGUAGE`; empty or absent for none. */
        language?: string;
        /** The new angle's hearing-impaired kind of view, if it is one. */
        accessibility?: AngleAccessibility;
        /** The single picture's `LANGUAGE`, as it becomes the main angle. */
        mainLanguage?: string;
    },
    variants: AddedAngleVariant[]
): string {
    const name = assertAngleName(names.name);
    const language = assertAngleLanguage(names.language ?? '');
    const kind =
        names.accessibility != null
            ? angleAccessibility(names.accessibility)
            : 'none';
    const master = parseMasterPlaylist(text);
    const angles = listVideoAngles(master);
    if (angles.length === 0) {
        throw new BadRequestException(
            'This video has no picture to add an angle beside'
        );
    }
    const single = angles[0].id === '';
    const mainName = single ? assertAngleName(names.mainName ?? 'Main') : '';
    const mainLanguage = single
        ? assertAngleLanguage(names.mainLanguage ?? '')
        : '';
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
            ? [videoGroupLine(mainId, mainName, mainLanguage, 'none', true)]
            : []),
        videoGroupLine(newId, name, language, kind, false),
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

/** A new angle's `TYPE=VIDEO` line, in the order {@link addVideoAngleLines} keeps. */
function videoGroupLine(
    id: string,
    name: string,
    language: string,
    kind: AngleAccessibility | 'none',
    isDefault: boolean
): string {
    return (
        `${MEDIA_TAG}TYPE=VIDEO,GROUP-ID="${id}",NAME="${name}"` +
        (language ? `,LANGUAGE="${language}"` : '') +
        (kind !== 'none'
            ? `,CHARACTERISTICS="${ANGLE_ACCESSIBILITY[kind]}"`
            : '') +
        `,DEFAULT=${isDefault ? 'YES' : 'NO'}`
    );
}

/**
 * Renames camera angles, sets or clears their language and hearing-impaired
 * kind, and takes the `removed` ones out of the master: their group, their
 * variants and their I-frame playlists. Their files stay in storage. When the
 * default angle goes, the first one left becomes it.
 *
 * Only what an edit names is touched, and a value already as asked is not
 * rewritten (a language differing only in the case of its letters, or
 * `CHARACTERISTICS` that already mark the kind asked for, count as asked), so
 * an edit that changes nothing leaves every line as it was. The line ends are
 * the exception: a master that mixes CRLF and LF comes back with CRLF
 * throughout. `CHARACTERISTICS` is written as the one identifier of the kind
 * asked for, replacing whatever the line had; a value that is none of ours
 * stays until an edit sets a kind, or clears one the line has.
 *
 * Checked first, so nothing is rewritten when an angle is unknown or edited
 * twice, both edited and removed, would be the last one taken out, a name or
 * language is invalid, or a name would be two angles'.
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
    // One edit per angle: a second would silently replace the first.
    const edited = new Set<string>();
    for (const { id } of edits) {
        if (edited.has(id)) {
            const name = angles.find((a) => a.id === id)?.name || id;
            throw new BadRequestException(`Angle "${name}" is edited twice`);
        }
        edited.add(id);
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
    const changes = new Map<string, AngleChange>(
        edits.map((e) => [
            e.id,
            {
                ...(e.name != null ? { name: assertAngleName(e.name) } : {}),
                ...(e.language != null
                    ? { language: assertAngleLanguage(e.language) }
                    : {}),
                ...(e.accessibility != null
                    ? { accessibility: angleAccessibility(e.accessibility) }
                    : {}),
            },
        ])
    );
    // As the names will be once the edit is made: an angle may take the name
    // of one removed, or of one renamed, in the same save.
    const finalNames = kept.map((a) => changes.get(a.id)?.name ?? a.name);
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
                const change = changes.get(id);
                if (change) {
                    out.push(MEDIA_TAG + applyAngleChange(attrs, change));
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

/**
 * A `TYPE=VIDEO` line's attributes with `change` made. A value already as
 * asked is left as written (an unquoted `NAME` stays unquoted), and clearing
 * one the line does not have changes nothing.
 */
function applyAngleChange(attrs: string, change: AngleChange): string {
    let out = attrs;
    if (
        change.name !== undefined &&
        readAttribute(out, 'NAME') !== change.name
    ) {
        out = writeAttribute(out, 'NAME', change.name);
    }
    if (change.language !== undefined) {
        // `FRA` is the `fra` the lister showed, sent back as it was read.
        out = setOrRemove(
            out,
            'LANGUAGE',
            change.language || undefined,
            (current) =>
                change.language !== '' &&
                current.replace(/^[A-Za-z]+/, (p) => p.toLowerCase()) ===
                    change.language
        );
    }
    if (change.accessibility !== undefined) {
        // The kind the lister read, sent back, leaves the line alone: written,
        // it would drop any identifier of someone else's beside ours.
        const kind = change.accessibility;
        out = setOrRemove(
            out,
            'CHARACTERISTICS',
            kind === 'none' ? undefined : ANGLE_ACCESSIBILITY[kind],
            (current) =>
                (angleAccessibilityOf(
                    current.split(',').map((c) => c.trim())
                ) ?? 'none') === kind
        );
    }
    return out;
}

/**
 * `name` written as quoted `value`, or taken off when `value` is undefined;
 * untouched when the line already has it so: quoted and equal, or quoted and
 * `same` as asked. An unquoted value is rewritten even when equal, since the
 * playlist parser reads only a quoted one and would go on showing none.
 */
function setOrRemove(
    list: string,
    name: string,
    value: string | undefined,
    same: (current: string) => boolean = (current) => current === value
): string {
    const match = attributePattern(name).exec(list);
    if (!match) {
        return value === undefined ? list : writeAttribute(list, name, value);
    }
    const quoted = match[2];
    if (quoted !== undefined && same(quoted)) return list;
    return value === undefined
        ? removeAttribute(list, name)
        : writeAttribute(list, name, value);
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
