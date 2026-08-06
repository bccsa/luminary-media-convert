import {
    attr,
    formatAttributeList,
    mergeAttributes,
    type HlsAttribute,
} from './attributes';
import { getAttributeSource, orderedHeaderNames } from './metadata';
import {
    formatResolution,
    getMasterLayout,
    IFRAME_MODELED_ATTRS,
    MEDIA_MODELED_ATTRS,
    VARIANT_MODELED_ATTRS,
    type HlsIFrameStream,
    type HlsMedia,
    type HlsParsedMaster,
    type HlsVariant,
} from './parse';

/**
 * Serialize a parsed master playlist back to HLS text.
 *
 * Round-trip invariant: `buildMasterPlaylist(parseMasterPlaylist(text))`
 * reproduces `text`, including tags and attributes the model does not
 * interpret — modulo blank lines, leading/trailing whitespace on a line, and
 * a `LANGUAGE` case fold. Entries the parser did not produce (anything a
 * caller built by hand, or copied with a spread) are serialized canonically.
 *
 * Canonical layout, used when the master carries no recorded line order:
 *   #EXTM3U
 *   #EXT-X-VERSION / #EXT-X-INDEPENDENT-SEGMENTS
 *   #EXT-X-MEDIA entries (audio, video, subtitles, closed-captions)
 *   #EXT-X-STREAM-INF entries, each followed by its URI on the next line
 *   #EXT-X-I-FRAME-STREAM-INF entries
 */
export function buildMasterPlaylist(master: HlsParsedMaster): string {
    const lines: string[] = ['#EXTM3U'];

    for (const tag of orderedHeaderNames(master, [
        '#EXT-X-VERSION',
        '#EXT-X-INDEPENDENT-SEGMENTS',
    ])) {
        if (tag === '#EXT-X-VERSION' && master.version !== undefined) {
            lines.push(`#EXT-X-VERSION:${master.version}`);
        } else if (
            tag === '#EXT-X-INDEPENDENT-SEGMENTS' &&
            master.independentSegments
        ) {
            lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
        }
    }

    const mediaSet = new Set<object>(master.media);
    const variantSet = new Set<object>(master.variants);
    const iFrameSet = new Set<object>(master.iFrameStreams ?? []);
    const emitted = new Set<object>();

    for (const item of getMasterLayout(master) ?? []) {
        if (typeof item === 'string') {
            lines.push(item);
            continue;
        }
        if (emitted.has(item)) continue;
        if (mediaSet.has(item)) {
            emitted.add(item);
            lines.push(formatMedia(item as HlsMedia));
        } else if (variantSet.has(item)) {
            emitted.add(item);
            const variant = item as HlsVariant;
            lines.push(formatStreamInf(variant), variant.uri);
        } else if (iFrameSet.has(item)) {
            emitted.add(item);
            lines.push(formatIFrameStreamInf(item as HlsIFrameStream));
        }
        // An entry no longer in the master was removed — drop it.
    }

    // Anything the layout did not cover (added after parsing, or never parsed).
    for (const type of [
        'AUDIO',
        'VIDEO',
        'SUBTITLES',
        'CLOSED-CAPTIONS',
    ] as const) {
        for (const m of master.media) {
            if (m.type !== type || emitted.has(m)) continue;
            emitted.add(m);
            lines.push(formatMedia(m));
        }
    }
    for (const v of master.variants) {
        if (emitted.has(v)) continue;
        emitted.add(v);
        lines.push(formatStreamInf(v), v.uri);
    }
    for (const f of master.iFrameStreams ?? []) {
        if (emitted.has(f)) continue;
        emitted.add(f);
        lines.push(formatIFrameStreamInf(f));
    }

    lines.push(''); // trailing newline
    return lines.join('\n');
}

function formatMedia(m: HlsMedia): string {
    const modeled: (HlsAttribute | undefined)[] = [
        attr('TYPE', m.type, false),
        attr('GROUP-ID', m.groupId, true),
        attr('NAME', m.name, true),
        attr('LANGUAGE', m.language?.toLowerCase(), true),
        yesNo('DEFAULT', m.default),
        yesNo('AUTOSELECT', m.autoselect),
        yesNo('FORCED', m.forced),
        attr('URI', m.uri, true),
    ];
    return `#EXT-X-MEDIA:${serialize(m, modeled, MEDIA_MODELED_ATTRS)}`;
}

function formatStreamInf(v: HlsVariant): string {
    const modeled: (HlsAttribute | undefined)[] = [
        attr('BANDWIDTH', v.bandwidth, false),
        attr('AVERAGE-BANDWIDTH', v.averageBandwidth, false),
        attr('RESOLUTION', resolutionText(v), false),
        attr('FRAME-RATE', v.frameRate, false),
        attr('CODECS', v.codecs, true),
        attr('VIDEO', v.videoGroup, true),
        attr('AUDIO', v.audioGroup, true),
        attr('SUBTITLES', v.subtitlesGroup, true),
    ];
    return `#EXT-X-STREAM-INF:${serialize(v, modeled, VARIANT_MODELED_ATTRS)}`;
}

function formatIFrameStreamInf(f: HlsIFrameStream): string {
    const modeled: (HlsAttribute | undefined)[] = [
        attr('BANDWIDTH', f.bandwidth, false),
        attr('AVERAGE-BANDWIDTH', f.averageBandwidth, false),
        attr('RESOLUTION', resolutionText(f), false),
        attr('CODECS', f.codecs, true),
        attr('VIDEO', f.videoGroup, true),
        attr('URI', f.uri, true),
    ];
    return `#EXT-X-I-FRAME-STREAM-INF:${serialize(f, modeled, IFRAME_MODELED_ATTRS)}`;
}

/**
 * `resolution` is the authoritative field; `resolutionParsed` is a convenience
 * read that only reaches the output when no raw string is set (a model built
 * in code). Callers changing the resolution should set the raw string.
 */
function resolutionText(
    entry: Pick<HlsVariant, 'resolution' | 'resolutionParsed'>
): string | undefined {
    if (entry.resolution) return entry.resolution;
    if (entry.resolutionParsed) return formatResolution(entry.resolutionParsed);
    return undefined;
}

function yesNo(name: string, value: boolean | undefined): HlsAttribute | undefined {
    if (value === undefined) return undefined;
    return { name, value: value ? 'YES' : 'NO', quoted: false };
}

function serialize(
    entry: object,
    modeled: (HlsAttribute | undefined)[],
    modeledNames: string[]
): string {
    return formatAttributeList(
        mergeAttributes(getAttributeSource(entry), modeled, modeledNames)
    );
}
