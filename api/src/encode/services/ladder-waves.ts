import type { VideoRenditionDto } from '../dto/encode-config.dto.js';

/**
 * Splitting a ladder across several ffmpeg runs so it stays under the driver's
 * concurrent-encode-session cap.
 *
 * One invocation with `split=N` opens N encoder sessions at once. GeForce
 * drivers cap those, and past the cap the extra sessions fail to open and take
 * the whole encode with them. The build carries no libx264 to fall back to, so
 * the ladder has to stay within the cap rather than recover from exceeding it.
 *
 * Each run decodes the source again, which is why this is waves of the cap
 * rather than one rendition at a time: six rungs cost two decodes, not six.
 *
 * Stream directories are named after the rendition (`stream_1080p_1920x1080`),
 * never the position within a run, so a wave writes its outputs straight to
 * their final names and nothing has to be renumbered afterwards. Only
 * `master.m3u8` would collide, so each wave writes its own and they are merged.
 */

export interface LadderWave {
    /** Renditions this run encodes. Copy-stream ones cost no session. */
    renditions: VideoRenditionDto[];
    /** Audio rides with the first wave; later waves are video only. */
    includeAudio: boolean;
    /** What this run passes to `-master_pl_name`. */
    masterName: string;
    /** Sessions to hold: copy-stream renditions do not open an encoder. */
    sessionCount: number;
}

/** `master_w<N>.m3u8`, merged into `master.m3u8` once every wave has run. */
export function waveMasterName(index: number): string {
    return `master_w${index}.m3u8`;
}

/**
 * Plan the runs for one ladder.
 *
 * A ladder that already fits under the cap returns a single wave writing
 * `master.m3u8` directly — byte-for-byte the previous behaviour, no merge step,
 * and the common case stays on the path that has always been exercised.
 *
 * Copy-stream renditions and the audio groups ride with the first wave: neither
 * opens an encoder session, so neither counts against the cap.
 */
export function planLadderWaves(
    renditions: VideoRenditionDto[],
    maxSessions: number
): LadderWave[] {
    const reencode = renditions.filter((r) => !r.copyStream);
    const copy = renditions.filter((r) => r.copyStream);

    // A cap below one would produce an infinite plan; treat it as "no splitting"
    // rather than trusting a caller's arithmetic.
    const perWave = Math.max(1, Math.floor(maxSessions));

    if (reencode.length <= perWave) {
        return [
            {
                renditions,
                includeAudio: true,
                masterName: 'master.m3u8',
                sessionCount: reencode.length,
            },
        ];
    }

    const waves: LadderWave[] = [];
    for (let i = 0; i < reencode.length; i += perWave) {
        const chunk = reencode.slice(i, i + perWave);
        const first = waves.length === 0;
        waves.push({
            // Order is preserved within the ladder as a whole: the merged master
            // lists variants wave by wave, and each wave in its original order.
            renditions: first ? [...chunk, ...copy] : chunk,
            includeAudio: first,
            masterName: waveMasterName(waves.length),
            sessionCount: chunk.length,
        });
    }
    return waves;
}

/** One `#EXT-X-STREAM-INF` line and the playlist URI beneath it. */
interface VariantBlock {
    attributes: string;
    uri: string;
}

function parseVariants(content: string): VariantBlock[] {
    const lines = content.split('\n');
    const blocks: VariantBlock[] = [];
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        // The URI is the next non-blank, non-comment line; a master playlist
        // that ends on the tag is malformed and simply contributes nothing.
        for (let j = i + 1; j < lines.length; j++) {
            const uri = lines[j].trim();
            if (!uri || uri.startsWith('#')) continue;
            blocks.push({
                attributes: lines[i].slice('#EXT-X-STREAM-INF:'.length),
                uri,
            });
            break;
        }
    }
    return blocks;
}

/** Codec tags that identify a video track; anything else in CODECS is audio. */
const VIDEO_CODEC = /^(avc1|avc3|hvc1|hev1|av01|vp09)\./;

/**
 * What ffmpeg actually called each audio group, keyed by the id the encode
 * config uses.
 *
 * The HLS muxer does not write `agroup` through verbatim — an agroup of `hd`
 * becomes `GROUP-ID="group_hd"` — so a variant that names the config's id points
 * at a group no player will find. Rather than hard-code that transformation, the
 * groups ffmpeg declared are read back and matched.
 */
function declaredAudioGroups(headerLines: string[]): Map<string, string> {
    const byConfigId = new Map<string, string>();
    for (const line of headerLines) {
        if (!line.startsWith('#EXT-X-MEDIA:')) continue;
        if (!/TYPE=AUDIO/.test(line)) continue;
        const declared = line.match(/GROUP-ID="([^"]+)"/)?.[1];
        if (!declared) continue;
        byConfigId.set(declared, declared);
        const stripped = declared.replace(/^group_/, '');
        if (!byConfigId.has(stripped)) byConfigId.set(stripped, declared);
    }
    return byConfigId;
}

/**
 * The audio codecs each group contributes, learnt from the variants that kept
 * their `AUDIO=` — the first wave's.
 *
 * A variant that references an audio group is supposed to list that group's
 * codecs too, and a run with no audio in it cannot know them.
 */
function audioCodecsByGroup(blocks: VariantBlock[]): Map<string, string[]> {
    const byGroup = new Map<string, string[]>();
    for (const block of blocks) {
        const group = block.attributes.match(/AUDIO="([^"]+)"/)?.[1];
        const codecs = block.attributes.match(/CODECS="([^"]+)"/)?.[1];
        if (!group || !codecs || byGroup.has(group)) continue;
        byGroup.set(
            group,
            codecs.split(',').filter((c) => !VIDEO_CODEC.test(c.trim()))
        );
    }
    return byGroup;
}

/**
 * Re-attach the audio group to a variant that lost it.
 *
 * Only the first wave is given the audio streams, so ffmpeg omits `AUDIO=` from
 * every later wave's variants — it has no group to point at. The association is
 * the ladder's, not that run's, so it is restored here from the rendition the
 * URI names, along with the codecs that come with it.
 */
function withAudioGroup(
    block: VariantBlock,
    audioGroupFor: (uri: string) => string | undefined,
    declared: Map<string, string>,
    codecsByGroup: Map<string, string[]>
): string {
    if (/(^|,)AUDIO=/.test(block.attributes)) {
        return `#EXT-X-STREAM-INF:${block.attributes}\n${block.uri}`;
    }

    const configId = audioGroupFor(block.uri);
    const group = configId ? declared.get(configId) : undefined;
    if (!group) {
        return `#EXT-X-STREAM-INF:${block.attributes}\n${block.uri}`;
    }

    let attributes = block.attributes;
    const missing = (codecsByGroup.get(group) ?? []).filter(
        (codec) => !attributes.includes(codec)
    );
    if (missing.length) {
        attributes = attributes.replace(
            /CODECS="([^"]+)"/,
            (_match, list: string) => `CODECS="${[list, ...missing].join(',')}"`
        );
    }

    return `#EXT-X-STREAM-INF:${attributes},AUDIO="${group}"\n${block.uri}`;
}

/**
 * Combine the waves' master playlists into one.
 *
 * Takes the header and every `#EXT-X-MEDIA` line from the first wave — the only
 * one that encoded audio — then every variant from every wave in order.
 */
export function mergeWaveMasters(
    contents: string[],
    audioGroupFor: (uri: string) => string | undefined
): string {
    const [first = ''] = contents;
    const header = first
        .split('\n')
        .filter(
            (line) =>
                line.startsWith('#EXTM3U') ||
                line.startsWith('#EXT-X-VERSION') ||
                line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS') ||
                line.startsWith('#EXT-X-MEDIA:')
        );

    const blocks = contents.flatMap((content) => parseVariants(content));
    const declared = declaredAudioGroups(header);
    const codecsByGroup = audioCodecsByGroup(blocks);

    const variants = blocks.map((block) =>
        withAudioGroup(block, audioGroupFor, declared, codecsByGroup)
    );

    return `${[...header, ...variants].join('\n')}\n`;
}
