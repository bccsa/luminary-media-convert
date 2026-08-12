import { describe, expect, it } from 'vitest';
import { buildChunkSchedules, type ChunkBoundary } from './prefetch.js';
import type { MungeResult } from './pipeline/pipeline.js';

const BASE = 'https://cdn.example.com/out/session';

/** A media playlist whose segments run through the named chunk objects. */
function chunkedPlaylist(
    runs: Array<{ chunk: string; segments: number }>,
    segmentSeconds = 4,
): string {
    const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MAP:URI="init.mp4"',
    ];
    for (const run of runs) {
        let offset = 0;
        for (let i = 0; i < run.segments; i++) {
            lines.push(`#EXTINF:${segmentSeconds.toFixed(6)},`);
            lines.push(`#EXT-X-BYTERANGE:1000@${offset}`);
            lines.push(run.chunk);
            offset += 1000;
        }
    }
    lines.push('#EXT-X-ENDLIST', '');
    return lines.join('\n');
}

function playlist(
    dir: string,
    text: string,
    mediaType = 'VIDEO',
): MungeResult['mediaPlaylists'][number] {
    return { url: `${BASE}/${dir}/playlist.m3u8`, mediaType, text };
}

const VIDEO_CHAIN = chunkedPlaylist([
    { chunk: '../media/v0_0.m4s', segments: 5 }, // 0–20s
    { chunk: '../media/v0_1.m4s', segments: 5 }, // 20–40s
]);

describe('buildChunkSchedules', () => {
    it('turns runs of identical chunk URLs into absolute boundaries', () => {
        const [schedule] = buildChunkSchedules([
            playlist('v0_1080', VIDEO_CHAIN),
        ]);

        expect(schedule).toEqual<ChunkBoundary[]>([
            { url: `${BASE}/media/v0_0.m4s`, start: 0, end: 20 },
            { url: `${BASE}/media/v0_1.m4s`, start: 20, end: 40 },
        ]);
    });

    it('keeps ONE schedule per chain however many renditions share it', () => {
        const schedules = buildChunkSchedules([
            playlist('v0_1080', VIDEO_CHAIN),
            playlist('v0_720', VIDEO_CHAIN),
            playlist('v0_480', VIDEO_CHAIN),
            playlist(
                'a_en',
                chunkedPlaylist([
                    { chunk: '../media/a_0.m4s', segments: 5 },
                    { chunk: '../media/a_1.m4s', segments: 5 },
                ]),
                'AUDIO',
            ),
        ]);

        expect(schedules).toHaveLength(2);
        expect(schedules.map((s) => s[0]?.url)).toEqual([
            `${BASE}/media/v0_0.m4s`,
            `${BASE}/media/a_0.m4s`,
        ]);
    });

    it('skips playlists with no byte ranges — nothing shared, nothing to warm', () => {
        const plain = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXTINF:4.000000,',
            'segment_0.m4s',
            '#EXT-X-ENDLIST',
            '',
        ].join('\n');

        expect(buildChunkSchedules([playlist('v0_1080', plain)])).toEqual([]);
    });

    it('has nothing to say about an empty munge', () => {
        expect(buildChunkSchedules([])).toEqual([]);
    });
});
