import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    FFMPEG_DOWNLOAD_URL,
    missingBinariesMessage,
    probeFfmpegBinaries,
    type FfmpegAvailability,
} from './ffmpeg-availability.js';

/**
 * These probes spawn real processes, which is the point: the bug being fixed was
 * a probe that could not tell "absent" from "present but limited", and a mocked
 * child process cannot demonstrate that distinction.
 *
 * `true` and `false` stand in for the binaries. Both exist on every platform this
 * runs on, accept being executed, and — crucially — do *not* understand
 * `-version`, so `true` is the "present" case and a path that cannot exist is
 * the "absent" one.
 */
const ORIGINAL = {
    ffmpeg: process.env.FFMPEG_PATH,
    ffprobe: process.env.FFPROBE_PATH,
};

const ABSENT = '/nonexistent/luminary-test/ffmpeg-that-is-not-installed';

function present(availability: FfmpegAvailability): string[] {
    return [
        availability.ffmpeg.present ? 'ffmpeg' : null,
        availability.ffprobe.present ? 'ffprobe' : null,
    ].filter((n): n is string => n !== null);
}

describe('probeFfmpegBinaries', () => {
    beforeEach(() => {
        delete process.env.FFMPEG_PATH;
        delete process.env.FFPROBE_PATH;
    });

    afterEach(() => {
        if (ORIGINAL.ffmpeg === undefined) delete process.env.FFMPEG_PATH;
        else process.env.FFMPEG_PATH = ORIGINAL.ffmpeg;
        if (ORIGINAL.ffprobe === undefined) delete process.env.FFPROBE_PATH;
        else process.env.FFPROBE_PATH = ORIGINAL.ffprobe;
    });

    it('reports both absent when neither path resolves', async () => {
        process.env.FFMPEG_PATH = ABSENT;
        process.env.FFPROBE_PATH = ABSENT;

        const availability = await probeFfmpegBinaries();

        expect(availability.ok).toBe(false);
        expect(present(availability)).toEqual([]);
    });

    it('reports one absent when only the other resolves', async () => {
        // Half-installed is a real state — a partial package, or a `pack` build
        // that copied neither while the machine has one on PATH.
        process.env.FFMPEG_PATH = '/usr/bin/true';
        process.env.FFPROBE_PATH = ABSENT;

        const availability = await probeFfmpegBinaries();

        expect(availability.ok).toBe(false);
        expect(present(availability)).toEqual(['ffmpeg']);
    });

    it('reports present for something that runs', async () => {
        process.env.FFMPEG_PATH = '/usr/bin/true';
        process.env.FFPROBE_PATH = '/usr/bin/true';

        const availability = await probeFfmpegBinaries();

        expect(availability.ok).toBe(true);
        expect(present(availability)).toEqual(['ffmpeg', 'ffprobe']);
    });

    it('reads the paths per call, so the host can set them after import', async () => {
        // ffbin.ts is deliberately not captured at import time; if this ever
        // regressed, the packaged app would probe PATH and ignore the binaries
        // it ships with.
        process.env.FFMPEG_PATH = ABSENT;
        process.env.FFPROBE_PATH = ABSENT;
        expect((await probeFfmpegBinaries()).ok).toBe(false);

        process.env.FFMPEG_PATH = '/usr/bin/true';
        process.env.FFPROBE_PATH = '/usr/bin/true';
        expect((await probeFfmpegBinaries()).ok).toBe(true);
    });
});

describe('missingBinariesMessage', () => {
    const ok: FfmpegAvailability = {
        ffmpeg: { bin: 'ffmpeg', present: true, version: '7.1' },
        ffprobe: { bin: 'ffprobe', present: true, version: '7.1' },
        ok: true,
    };

    it('says nothing when both are there', () => {
        expect(missingBinariesMessage(ok)).toBeNull();
    });

    it('names what is missing and where to get it', () => {
        const message = missingBinariesMessage({
            ffmpeg: { bin: 'ffmpeg', present: false },
            ffprobe: { bin: 'ffprobe', present: false },
            ok: false,
        });

        expect(message).toContain('ffmpeg and ffprobe');
        expect(message).toContain('PATH');
        expect(message).toContain(FFMPEG_DOWNLOAD_URL);
    });

    it('names only the one that is missing', () => {
        const message = missingBinariesMessage({
            ...ok,
            ffprobe: { bin: 'ffprobe', present: false },
            ok: false,
        });

        // The clause naming what is missing, specifically — "ffmpeg and ffprobe"
        // also occurs in the advice ("Install FFmpeg — which provides both …"),
        // so a bare substring check here would pass on the wrong sentence.
        expect(message).toContain('could not be run: ffprobe was not found');
    });

    it('blames the configuration, not the install, when a path was given', () => {
        // Being told to install something that is installed, because a host
        // passed a bad FFMPEG_PATH, sends the reader in the wrong direction.
        const message = missingBinariesMessage({
            ...ok,
            ffmpeg: { bin: '/opt/luminary/ffmpeg', present: false },
            ok: false,
        });

        expect(message).toContain('/opt/luminary/ffmpeg');
        expect(message).toContain('does not point at a working executable');
        expect(message).not.toContain('on your PATH');
    });
});
