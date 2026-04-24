import type { HlsMedia, HlsParsedMaster, HlsVariant } from './parse';

/**
 * Serialize a parsed master playlist back to HLS text.
 *
 * Round-trip invariant: for a playlist that only contains the tags this
 * library understands, parseMasterPlaylist(buildMasterPlaylist(p)) yields a
 * structure deep-equal to p. Unknown tags are NOT round-tripped — the
 * builder emits only the subset the parser exposes.
 *
 * Output layout:
 *   #EXTM3U
 *   #EXT-X-MEDIA entries (audio, then subtitles, then closed-captions)
 *   #EXT-X-STREAM-INF entries, each followed by its URI on the next line
 */
export function buildMasterPlaylist(master: HlsParsedMaster): string {
    const lines: string[] = ['#EXTM3U'];

    const mediaByType: Record<HlsMedia['type'], HlsMedia[]> = {
        AUDIO: [],
        SUBTITLES: [],
        'CLOSED-CAPTIONS': [],
    };
    for (const m of master.media) {
        mediaByType[m.type].push(m);
    }

    for (const type of ['AUDIO', 'SUBTITLES', 'CLOSED-CAPTIONS'] as const) {
        for (const m of mediaByType[type]) {
            lines.push(formatMedia(m));
        }
    }

    for (const v of master.variants) {
        lines.push(formatStreamInf(v));
        lines.push(v.uri);
    }

    lines.push(''); // trailing newline
    return lines.join('\n');
}

function formatMedia(m: HlsMedia): string {
    const attrs: string[] = [
        `TYPE=${m.type}`,
        `GROUP-ID="${m.groupId}"`,
        `NAME="${m.name}"`,
    ];
    if (m.language) attrs.push(`LANGUAGE="${m.language}"`);
    if (m.default) attrs.push('DEFAULT=YES');
    if (m.autoselect) attrs.push('AUTOSELECT=YES');
    if (m.forced) attrs.push('FORCED=YES');
    if (m.uri) attrs.push(`URI="${m.uri}"`);
    return `#EXT-X-MEDIA:${attrs.join(',')}`;
}

function formatStreamInf(v: HlsVariant): string {
    const attrs: string[] = [`BANDWIDTH=${v.bandwidth}`];
    if (v.resolution) attrs.push(`RESOLUTION=${v.resolution}`);
    if (v.codecs) attrs.push(`CODECS="${v.codecs}"`);
    return `#EXT-X-STREAM-INF:${attrs.join(',')}`;
}
