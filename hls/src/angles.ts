/**
 * Client-side multi-angle extraction.
 *
 * The encoder writes one spec-correct multi-angle master playlist: each camera
 * angle is an `#EXT-X-MEDIA:TYPE=VIDEO` rendition group and every
 * `#EXT-X-STREAM-INF` carries `VIDEO="<group>"`. Most HLS players ignore video
 * rendition groups and just play whichever variant their ABR logic picks, so a
 * player that wants to pin one angle (or drop video altogether) has to narrow
 * the master itself. These helpers do exactly that, on the playlist text, with
 * no player or network dependency.
 */

export interface VideoAngle {
    /** `GROUP-ID` of the video rendition group — pass to `extractAnglePlaylist`. */
    id: string;
    /** `NAME` attribute, or the id when the master omits one. */
    name: string;
    /** `DEFAULT=YES` — the angle a player should start on. */
    isDefault: boolean;
}

const DEFAULT_AUDIO_BANDWIDTH = 128_000;
const DEFAULT_AUDIO_CODEC = 'mp4a.40.2';

/**
 * List the video rendition groups (camera angles) in a master playlist.
 * Returns `[]` for a single-angle master, which has no `TYPE=VIDEO` groups.
 */
export function listVideoAngles(masterText: string): VideoAngle[] {
    const angles: VideoAngle[] = [];
    const seen = new Set<string>();

    for (const line of masterText.split('\n')) {
        const trimmed = line.trim();
        if (!isVideoMediaLine(trimmed)) continue;

        const attrs = trimmed.slice('#EXT-X-MEDIA:'.length);
        const id = quotedAttr(attrs, 'GROUP-ID');
        if (!id || seen.has(id)) continue;
        seen.add(id);

        angles.push({
            id,
            name: quotedAttr(attrs, 'NAME') ?? id,
            isDefault: plainAttr(attrs, 'DEFAULT') === 'YES',
        });
    }

    return angles;
}

/**
 * Narrow a multi-angle master to a single angle: keep only the variants
 * belonging to `angleId`, strip their now-meaningless `VIDEO` attribute, and
 * drop the `TYPE=VIDEO` media lines. Audio (and any other non-video) rendition
 * groups are carried over untouched.
 *
 * A master with no video groups — or one where `angleId` matches nothing — is
 * returned unchanged, so callers can apply this unconditionally.
 */
export function extractAnglePlaylist(
    masterText: string,
    angleId: string
): string {
    const lines = masterText.split('\n');

    let extVersion = '#EXT-X-VERSION:3';
    const mediaLines: string[] = [];
    const streams: { infLine: string; uri: string }[] = [];
    let sawVideoGroup = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXT-X-VERSION:')) {
            extVersion = line;
        } else if (isVideoMediaLine(line)) {
            sawVideoGroup = true;
        } else if (line.startsWith('#EXT-X-MEDIA:')) {
            mediaLines.push(line);
        } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const uri = lines[i + 1]?.trim();
            if (!uri || uri.startsWith('#')) continue;
            if (quotedAttr(line, 'VIDEO') !== angleId) continue;
            streams.push({
                infLine: line.replace(/,?VIDEO="[^"]*"/g, ''),
                uri,
            });
        }
    }

    if (!sawVideoGroup || streams.length === 0) return masterText;

    const parts = ['#EXTM3U', extVersion, ...mediaLines];
    for (const { infLine, uri } of streams) {
        parts.push(infLine, uri);
    }
    return parts.join('\n') + '\n';
}

/**
 * Build an audio-only master from the audio rendition groups of `masterText`:
 * one variant per `GROUP-ID`, pointing at that group's first rendition.
 *
 * Bandwidth is read off the encoder's stream directory naming (`..._128kbps/`)
 * when present and otherwise assumed, since a master playlist never states the
 * bitrate of an audio rendition on its own. Codecs come from the audio token of
 * a variant that uses the group.
 *
 * Returns `null` when the master has no audio rendition groups.
 */
export function extractAudioOnlyPlaylist(masterText: string): string | null {
    const lines = masterText.split('\n');

    let extVersion = '#EXT-X-VERSION:7';
    /** GROUP-ID → the group's `#EXT-X-MEDIA` lines, in playlist order. */
    const groups = new Map<string, { line: string; uri: string }[]>();
    /** GROUP-ID → audio codec token from a variant referencing it. */
    const codecs = new Map<string, string>();

    for (const raw of lines) {
        const line = raw.trim();

        if (line.startsWith('#EXT-X-VERSION:')) {
            extVersion = line;
            continue;
        }

        if (
            line.startsWith('#EXT-X-MEDIA:') &&
            plainAttr(line, 'TYPE') === 'AUDIO'
        ) {
            const groupId = quotedAttr(line, 'GROUP-ID');
            const uri = quotedAttr(line, 'URI');
            if (!groupId || !uri) continue;
            if (!groups.has(groupId)) groups.set(groupId, []);
            groups.get(groupId)!.push({ line, uri });
            continue;
        }

        if (line.startsWith('#EXT-X-STREAM-INF:')) {
            const groupId = quotedAttr(line, 'AUDIO');
            if (!groupId || codecs.has(groupId)) continue;
            const codec = audioCodec(quotedAttr(line, 'CODECS'));
            if (codec) codecs.set(groupId, codec);
        }
    }

    if (groups.size === 0) return null;

    const parts = ['#EXTM3U', extVersion];
    for (const [, members] of groups) {
        for (const { line } of members) parts.push(line);
    }

    parts.push('');
    for (const [groupId, members] of groups) {
        const bandwidth =
            Math.max(...members.map((m) => bitrateFromUri(m.uri) ?? 0)) ||
            DEFAULT_AUDIO_BANDWIDTH;
        parts.push(
            `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="${codecs.get(groupId) ?? DEFAULT_AUDIO_CODEC}",AUDIO="${groupId}"`,
            members[0].uri
        );
    }

    return parts.join('\n') + '\n';
}

function isVideoMediaLine(line: string): boolean {
    return (
        line.startsWith('#EXT-X-MEDIA:') && plainAttr(line, 'TYPE') === 'VIDEO'
    );
}

/** `NAME="value"` → `value`. */
function quotedAttr(attrs: string, name: string): string | undefined {
    const match = attrs.match(new RegExp(`(?:^|[,:])\\s*${name}="([^"]*)"`));
    return match ? match[1] : undefined;
}

/** `NAME=VALUE` (unquoted) → `VALUE`. */
function plainAttr(attrs: string, name: string): string | undefined {
    const match = attrs.match(new RegExp(`(?:^|[,:])\\s*${name}=([^",]+)`));
    return match ? match[1].trim() : undefined;
}

/**
 * The encoder names audio stream directories `stream_<tier>_<label>/`, where the
 * label defaults to the configured bitrate (`stream_hd_128kbps/playlist.m3u8`).
 */
function bitrateFromUri(uri: string): number | null {
    const match = uri.match(/(\d+)\s*kbps/i);
    return match ? parseInt(match[1], 10) * 1000 : null;
}

/** Pick the audio entry out of a `CODECS` list (`"avc1.64001f,mp4a.40.2"`). */
function audioCodec(codecList: string | undefined): string | undefined {
    if (!codecList) return undefined;
    return codecList
        .split(',')
        .map((c) => c.trim())
        .find((c) => /^(mp4a|ac-3|ec-3|opus|vorbis|fLaC|alac)/i.test(c));
}
