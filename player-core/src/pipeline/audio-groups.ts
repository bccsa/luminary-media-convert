/**
 * One audio group where a master offers the same languages in several.
 *
 * Some packagers (Nimble, for one) list every language twice, in a stereo and a
 * mono group, with each video rendition repeated once per group. An engine then
 * lists every language twice in its own track list, and its renditions twice
 * too. The groups are told apart by their contents, not their names: two groups
 * holding the same languages under the same names are the same choice for the
 * viewer, and the richer one is kept (most channels, else the one holding the
 * default, else the one named stereo, else the first).
 *
 * A group is dropped only when every rendition that uses it has a twin, the same
 * media playlist, on the group kept, so nothing that played before becomes
 * unreachable. Anything else is left exactly as it was.
 */

const MEDIA_PREFIX = '#EXT-X-MEDIA:';
const VARIANT_PREFIX = '#EXT-X-STREAM-INF:';

interface AudioGroup {
    id: string;
    order: number;
    entries: string[];
    channels: number;
    hasDefault: boolean;
}

/** Attribute values of one tag line, quoted or bare, by name. */
function attributes(line: string): Map<string, string> {
    const found = new Map<string, string>();
    const body = line.slice(line.indexOf(':') + 1);
    const pattern = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    for (const match of body.matchAll(pattern)) {
        const [, name, raw, quoted] = match;
        if (name !== undefined) found.set(name, quoted ?? raw ?? '');
    }
    return found;
}

/** The media playlist a variant line points at: the next line that is not a tag or blank. */
function variantUri(lines: string[], index: number): number {
    for (let i = index + 1; i < lines.length; i++) {
        const line = lines[i]?.trim();
        if (line && !line.startsWith('#')) return i;
    }
    return -1;
}

function richer(a: AudioGroup, b: AudioGroup): AudioGroup {
    if (a.channels !== b.channels) return a.channels > b.channels ? a : b;
    if (a.hasDefault !== b.hasDefault) return a.hasDefault ? a : b;
    const stereo = (group: AudioGroup) => /stereo/i.test(group.id);
    if (stereo(a) !== stereo(b)) return stereo(a) ? a : b;
    return a.order <= b.order ? a : b;
}

export function collapseAudioGroups(text: string): string {
    const lines = text.split(/\r?\n/);
    const groups = new Map<string, AudioGroup>();
    for (const line of lines) {
        if (!line.startsWith(MEDIA_PREFIX)) continue;
        const attrs = attributes(line);
        if (attrs.get('TYPE') !== 'AUDIO') continue;
        const id = attrs.get('GROUP-ID');
        if (id === undefined) continue;
        const group =
            groups.get(id) ??
            { id, order: groups.size, entries: [], channels: 0, hasDefault: false };
        group.entries.push(`${attrs.get('LANGUAGE') ?? ''}|${attrs.get('NAME') ?? ''}`);
        group.channels = Math.max(group.channels, Number.parseInt(attrs.get('CHANNELS') ?? '', 10) || 0);
        group.hasDefault ||= attrs.get('DEFAULT') === 'YES';
        groups.set(id, group);
    }
    if (groups.size < 2) return text;

    // Variants by the group they use, each with its media playlist.
    const variants: { line: number; uri: number; group: string | undefined; target: string }[] = [];
    lines.forEach((line, index) => {
        if (!line.startsWith(VARIANT_PREFIX)) return;
        const uri = variantUri(lines, index);
        if (uri < 0) return;
        variants.push({ line: index, uri, group: attributes(line).get('AUDIO'), target: lines[uri]?.trim() ?? '' });
    });

    const bySignature = new Map<string, AudioGroup[]>();
    for (const group of groups.values()) {
        const signature = [...group.entries].sort().join('\n');
        bySignature.set(signature, [...(bySignature.get(signature) ?? []), group]);
    }

    const dropped = new Set<string>();
    for (const same of bySignature.values()) {
        if (same.length < 2) continue;
        const kept = same.reduce(richer);
        const keptTargets = new Set(variants.filter((v) => v.group === kept.id).map((v) => v.target));
        for (const group of same) {
            if (group === kept) continue;
            const reachable = variants
                .filter((v) => v.group === group.id)
                .every((v) => keptTargets.has(v.target));
            if (reachable) dropped.add(group.id);
        }
    }
    if (dropped.size === 0) return text;

    const remove = new Set<number>();
    lines.forEach((line, index) => {
        if (!line.startsWith(MEDIA_PREFIX)) return;
        const attrs = attributes(line);
        if (attrs.get('TYPE') === 'AUDIO' && dropped.has(attrs.get('GROUP-ID') ?? '')) remove.add(index);
    });
    for (const variant of variants) {
        if (variant.group !== undefined && dropped.has(variant.group)) {
            remove.add(variant.line);
            remove.add(variant.uri);
        }
    }
    return lines.filter((_, index) => !remove.has(index)).join('\n');
}
