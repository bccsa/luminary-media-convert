import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm, truncate, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { VideoTrackInfo } from './probe.service.js';
import {
    cadenceBoundaries,
    PreviewService,
    regularKeyframeInterval,
} from './preview.service.js';

const track = (gop: Partial<VideoTrackInfo>): VideoTrackInfo =>
    ({ codec: 'h264', frameRate: 25, ...gop }) as VideoTrackInfo;

describe('regularKeyframeInterval', () => {
    it('is the interval in seconds for a regular one', () => {
        expect(
            regularKeyframeInterval(track({ gopFrames: 50, gopRegular: true }))
        ).toBe(2);
    });

    it('is null for an irregular one', () => {
        expect(
            regularKeyframeInterval(track({ gopFrames: 50, gopRegular: false }))
        ).toBeNull();
    });

    it('is null when the sample could not have seen it twice', () => {
        // 100 frames twice over fills the 200-frame head sample: one interval at most.
        expect(
            regularKeyframeInterval(track({ gopFrames: 100, gopRegular: true }))
        ).toBeNull();
    });

    it('is null without a frame rate', () => {
        expect(
            regularKeyframeInterval(
                track({ gopFrames: 50, gopRegular: true, frameRate: 0 })
            )
        ).toBeNull();
    });
});

describe('cadenceBoundaries', () => {
    it('counts from the first keyframe, not from zero', () => {
        // A .ts whose clock starts at 1.4 s, a keyframe every second.
        const b = cadenceBoundaries(1.4, 25, 25, 21.4);
        expect(b.map((s) => s.start)).toEqual([1.4, 5.4, 9.4, 13.4, 17.4]);
        expect(b.every((s) => Math.abs(s.duration - 4) < 1e-9)).toBe(true);
    });

    it('makes each segment the fewest whole intervals that reach four seconds', () => {
        const b = cadenceBoundaries(0, 75, 25, 12); // 3 s intervals
        expect(b.map((s) => [s.start, s.duration])).toEqual([
            [0, 6],
            [6, 6],
        ]);
    });

    it('gives an interval longer than four seconds a segment each', () => {
        const b = cadenceBoundaries(0, 150, 25, 18);
        expect(b.map((s) => s.start)).toEqual([0, 6, 12]);
    });

    it('joins a tail shorter than half an interval to the segment before it', () => {
        // Audio that outlasts the picture by a few frames.
        const b = cadenceBoundaries(0, 25, 25, 8.3);
        expect(b).toHaveLength(2);
        expect(b[1].start).toBe(4);
        expect(b[1].duration).toBeCloseTo(4.3, 9);
    });

    it('keeps a tail of half an interval or more as its own segment', () => {
        const b = cadenceBoundaries(0, 25, 25, 8.6);
        expect(b.map((s) => s.start)).toEqual([0, 4, 8]);
        expect(b[2].duration).toBeCloseTo(0.6, 9);
    });

    it('does not drift over an hour at 29.97 fps', () => {
        const fps = 30000 / 1001;
        const b = cadenceBoundaries(0, 30, fps, 3600);
        const last = b[b.length - 1];
        const n = b.length - 1;
        // Exactly 120 frames per segment, wherever it lands.
        expect(Math.abs(last.start - (n * 120) / fps)).toBeLessThan(1e-6);
        expect(Math.abs(last.start + last.duration - 3600)).toBeLessThan(1e-9);
    });
});

describe('PreviewService copy cache', () => {
    let dir: string;
    const service = new PreviewService({} as any, {} as any);
    const trim = (d: string) => (service as any).trimCopyCache(d);

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'preview-cache-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    /** Writes segments 0..count-1, segment 0 the oldest. */
    const segments = async (count: number, bytes = 10) => {
        const now = Date.now() / 1000;
        for (let i = 0; i < count; i++) {
            const path = join(dir, `segment${i}.ts`);
            await writeFile(path, Buffer.alloc(bytes));
            await utimes(path, now - (count - i), now - (count - i));
        }
    };

    const kept = async () =>
        (await readdir(dir))
            .filter((n) => n.startsWith('segment'))
            .map((n) => Number(/\d+/.exec(n)![0]))
            .sort((a, b) => a - b);

    it('keeps the newest 16 segments', async () => {
        await segments(20);
        await trim(dir);
        expect(await kept()).toEqual(
            Array.from({ length: 16 }, (_, i) => i + 4)
        );
    });

    it('keeps fewer once the newest pass 500 MB, but never fewer than four', async () => {
        await segments(10);
        // Sparse: sized without the disk.
        for (let i = 0; i < 10; i++) {
            await truncate(join(dir, `segment${i}.ts`), 100 * 1024 * 1024);
        }
        await trim(dir);
        expect(await kept()).toEqual([5, 6, 7, 8, 9]);

        for (const i of [5, 6, 7, 8, 9]) {
            await truncate(join(dir, `segment${i}.ts`), 400 * 1024 * 1024);
        }
        await trim(dir);
        expect(await kept()).toEqual([6, 7, 8, 9]);
    });

    it('leaves a folder under the window alone', async () => {
        await segments(4);
        await trim(dir);
        expect(await kept()).toEqual([0, 1, 2, 3]);
    });

    it('ignores files that are not finished segments', async () => {
        await segments(20);
        await writeFile(join(dir, 'segment99.ts.part'), 'x');
        await writeFile(join(dir, 'playlist.m3u8'), 'x');
        await trim(dir);
        const names = await readdir(dir);
        expect(names).toContain('segment99.ts.part');
        expect(names).toContain('playlist.m3u8');
    });

    it('does nothing for a folder that is gone', async () => {
        await expect(trim(join(dir, 'missing'))).resolves.toBeUndefined();
    });
});
