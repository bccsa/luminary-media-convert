import { describe, expect, it, vi } from 'vitest';
import { candidateBinaries, resolveFfmpegBinary } from './ffmpeg-location';

const BUNDLED = '/app/Resources/ffmpeg';
const CHOSEN = '/Users/someone/ffmpeg-build';

/** Defaults describing a normal packaged run: a bundled binary, nothing chosen. */
function input(
    overrides: Partial<Parameters<typeof resolveFfmpegBinary>[1]> = {}
) {
    return {
        env: {} as NodeJS.ProcessEnv,
        ffmpegDir: null,
        bundled: (name: string) => `/app/Resources/${name}`,
        platform: 'darwin' as NodeJS.Platform,
        exists: () => true,
        ...overrides,
    };
}

describe('resolveFfmpegBinary', () => {
    it('uses the bundled binary when nothing else is set', () => {
        expect(resolveFfmpegBinary('ffmpeg', input())).toBe(BUNDLED);
        expect(resolveFfmpegBinary('ffprobe', input())).toBe(
            '/app/Resources/ffprobe'
        );
    });

    it('uses the chosen directory when one is set', () => {
        expect(
            resolveFfmpegBinary('ffmpeg', input({ ffmpegDir: CHOSEN }))
        ).toBe(`${CHOSEN}/ffmpeg`);
        expect(
            resolveFfmpegBinary('ffprobe', input({ ffmpegDir: CHOSEN }))
        ).toBe(`${CHOSEN}/ffprobe`);
    });

    // The environment is the more deliberate instruction of the two, and it is
    // the developer escape hatch. It used not to work at all in a packaged
    // build, because the bundled path was written over it.
    it('lets the environment outrank both the setting and the bundle', () => {
        const env = {
            FFMPEG_PATH: '/opt/ffmpeg',
            FFPROBE_PATH: '/opt/ffprobe',
        } as NodeJS.ProcessEnv;

        expect(
            resolveFfmpegBinary('ffmpeg', input({ env, ffmpegDir: CHOSEN }))
        ).toBe('/opt/ffmpeg');
        expect(resolveFfmpegBinary('ffmpeg', input({ env }))).toBe(
            '/opt/ffmpeg'
        );
        expect(
            resolveFfmpegBinary('ffprobe', input({ env, ffmpegDir: CHOSEN }))
        ).toBe('/opt/ffprobe');
    });

    it('reads the variable belonging to the binary asked for', () => {
        const env = { FFMPEG_PATH: '/opt/ffmpeg' } as NodeJS.ProcessEnv;
        // ffprobe has no override here, so it must not inherit ffmpeg's.
        expect(resolveFfmpegBinary('ffprobe', input({ env }))).toBe(
            '/app/Resources/ffprobe'
        );
    });

    // An external drive that is not plugged in, or a folder since deleted.
    // Falling back beats refusing to start; the caller keeps the setting.
    it('falls back to the bundle when the chosen directory has gone', () => {
        const warn = vi.fn();
        const resolved = resolveFfmpegBinary(
            'ffmpeg',
            input({ ffmpegDir: CHOSEN, exists: () => false, warn })
        );

        expect(resolved).toBe(BUNDLED);
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain(CHOSEN);
    });

    it('says nothing when the chosen directory is present', () => {
        const warn = vi.fn();
        resolveFfmpegBinary('ffmpeg', input({ ffmpegDir: CHOSEN, warn }));
        expect(warn).not.toHaveBeenCalled();
    });

    it('adds .exe on Windows and nowhere else', () => {
        expect(
            resolveFfmpegBinary(
                'ffmpeg',
                input({ ffmpegDir: 'C:\\ff', platform: 'win32' })
            )
        ).toContain('ffmpeg.exe');
        expect(
            resolveFfmpegBinary('ffmpeg', input({ ffmpegDir: CHOSEN }))
        ).not.toContain('.exe');
    });

    // No bundled copy and nothing chosen: the API then tries PATH and, failing
    // that, tells the user ffmpeg is required.
    it('returns undefined when there is nothing to run', () => {
        expect(
            resolveFfmpegBinary('ffmpeg', input({ bundled: () => undefined }))
        ).toBeUndefined();
    });

    it('ignores an empty environment variable rather than running it', () => {
        const env = { FFMPEG_PATH: '' } as NodeJS.ProcessEnv;
        expect(resolveFfmpegBinary('ffmpeg', input({ env }))).toBe(BUNDLED);
    });
});

describe('candidateBinaries', () => {
    // A directory is validated through these paths and later resolved through
    // resolveFfmpegBinary's. If the two disagreed, a folder could validate and
    // then not be found.
    it('names the same files resolution will look for', () => {
        for (const platform of ['darwin', 'win32'] as NodeJS.Platform[]) {
            const { ffmpeg, ffprobe } = candidateBinaries(CHOSEN, platform);
            expect(
                resolveFfmpegBinary(
                    'ffmpeg',
                    input({ ffmpegDir: CHOSEN, platform })
                )
            ).toBe(ffmpeg);
            expect(
                resolveFfmpegBinary(
                    'ffprobe',
                    input({ ffmpegDir: CHOSEN, platform })
                )
            ).toBe(ffprobe);
        }
    });
});
