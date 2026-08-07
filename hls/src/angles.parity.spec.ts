/**
 * Parity proof for the model-based rewrite of `angles.ts`.
 *
 * The three text-in/text-out helpers used to work directly on playlist lines.
 * They now parse into the lossless model, narrow it, and build. To prove that
 * did not shift a single byte of their output, the original line-based
 * implementations are reproduced verbatim below and asserted against the
 * current ones over the shapes the encoder actually emits.
 *
 * Two knowingly-unmatched corners of the old behaviour, neither reachable from
 * real playlists, are documented at the bottom of this file.
 */

import { describe, it, expect } from 'vitest';
import {
    listVideoAngles,
    extractAnglePlaylist,
    extractAudioOnlyPlaylist,
} from './angles';
import {
    MULTI_ANGLE_MASTER,
    SINGLE_ANGLE_MASTER,
    AUDIO_ONLY_MASTER,
    MULTI_ANGLE_WITH_SUBTITLES_MASTER,
    MULTI_TIER_AUDIO_MASTER,
} from './fixtures';

// ---------------------------------------------------------------------------
// The pre-rewrite implementation, copied verbatim from git history.
// ---------------------------------------------------------------------------

interface LegacyVideoAngle {
    id: string;
    name: string;
    isDefault: boolean;
}

const DEFAULT_AUDIO_BANDWIDTH = 128_000;
const DEFAULT_AUDIO_CODEC = 'mp4a.40.2';

function legacyListVideoAngles(masterText: string): LegacyVideoAngle[] {
    const angles: LegacyVideoAngle[] = [];
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

function legacyExtractAnglePlaylist(masterText: string, angleId: string): string {
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

function legacyExtractAudioOnlyPlaylist(masterText: string): string | null {
    const lines = masterText.split('\n');

    let extVersion = '#EXT-X-VERSION:7';
    const groups = new Map<string, { line: string; uri: string }[]>();
    const codecs = new Map<string, string>();

    for (const raw of lines) {
        const line = raw.trim();

        if (line.startsWith('#EXT-X-VERSION:')) {
            extVersion = line;
            continue;
        }

        if (line.startsWith('#EXT-X-MEDIA:') && plainAttr(line, 'TYPE') === 'AUDIO') {
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
    return line.startsWith('#EXT-X-MEDIA:') && plainAttr(line, 'TYPE') === 'VIDEO';
}

function quotedAttr(attrs: string, name: string): string | undefined {
    const match = attrs.match(new RegExp(`(?:^|[,:])\\s*${name}="([^"]*)"`));
    return match ? match[1] : undefined;
}

function plainAttr(attrs: string, name: string): string | undefined {
    const match = attrs.match(new RegExp(`(?:^|[,:])\\s*${name}=([^",]+)`));
    return match ? match[1].trim() : undefined;
}

function bitrateFromUri(uri: string): number | null {
    const match = uri.match(/(\d+)\s*kbps/i);
    return match ? parseInt(match[1], 10) * 1000 : null;
}

function audioCodec(codecList: string | undefined): string | undefined {
    if (!codecList) return undefined;
    return codecList
        .split(',')
        .map((c) => c.trim())
        .find((c) => /^(mp4a|ac-3|ec-3|opus|vorbis|fLaC|alac)/i.test(c));
}

// ---------------------------------------------------------------------------

const FIXTURES: [name: string, text: string][] = [
    ['multi-angle master', MULTI_ANGLE_MASTER],
    ['single-angle master', SINGLE_ANGLE_MASTER],
    ['audio-only master', AUDIO_ONLY_MASTER],
    ['multi-angle master with SUBTITLES', MULTI_ANGLE_WITH_SUBTITLES_MASTER],
    ['multi-tier audio master', MULTI_TIER_AUDIO_MASTER],
];

describe('angles — parity with the pre-rewrite implementation', () => {
    describe.each(FIXTURES)('%s', (_name, text) => {
        it('listVideoAngles matches', () => {
            expect(listVideoAngles(text)).toEqual(legacyListVideoAngles(text));
        });

        it('extractAudioOnlyPlaylist matches', () => {
            expect(extractAudioOnlyPlaylist(text)).toBe(
                legacyExtractAudioOnlyPlaylist(text)
            );
        });

        it('extractAnglePlaylist matches for every angle', () => {
            const angleIds = legacyListVideoAngles(text).map((a) => a.id);
            // Plus an id that matches nothing, to cover the passthrough path.
            for (const id of [...angleIds, 'no-such-angle']) {
                expect(extractAnglePlaylist(text, id)).toBe(
                    legacyExtractAnglePlaylist(text, id)
                );
            }
        });
    });
});

describe('angles — deliberate divergences from the old line-based helpers', () => {
    it('falls back to the group id for an empty NAME, where the old code returned an empty string', () => {
        const master = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME=""',
            '#EXT-X-STREAM-INF:BANDWIDTH=1,VIDEO="main"',
            'a.m3u8',
        ].join('\n');

        expect(listVideoAngles(master)[0].name).toBe('main');
        expect(legacyListVideoAngles(master)[0].name).toBe('');
    });

    it('drops a leading VIDEO attribute cleanly, where the old regex left a stray comma', () => {
        const master = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="main"',
            '#EXT-X-STREAM-INF:VIDEO="main",BANDWIDTH=1000',
            'a.m3u8',
        ].join('\n');

        expect(extractAnglePlaylist(master, 'main')).toContain(
            '#EXT-X-STREAM-INF:BANDWIDTH=1000'
        );
        expect(legacyExtractAnglePlaylist(master, 'main')).toContain(
            '#EXT-X-STREAM-INF:,BANDWIDTH=1000'
        );
    });
});
