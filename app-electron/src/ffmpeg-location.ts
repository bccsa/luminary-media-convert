import { join } from 'node:path';

/**
 * Which ffmpeg the app runs, and why that is a licence question.
 *
 * We ship an LGPL ffmpeg and invoke it as a separate program. Being able to
 * replace it with your own copy is the condition attached to distributing it
 * that way, so "the bundled one, always" is not an option the licence leaves
 * open to us.
 *
 * Kept apart from main.ts so it can be tested without Electron: everything it
 * consults is passed in. The real wiring in main.ts supplies the process
 * environment, the persisted setting, and the packaged-binary lookup.
 */
export interface FfmpegLocationInput {
    /** Usually `process.env`. Read for FFMPEG_PATH / FFPROBE_PATH. */
    env: NodeJS.ProcessEnv;
    /** The directory the user chose, or null when they never have. */
    ffmpegDir?: string | null;
    /** The copy packaging put beside the app, if there is one. */
    bundled: (name: string) => string | undefined;
    /** `process.platform`; only 'win32' changes the filename. */
    platform: NodeJS.Platform;
    /** Usually `existsSync`. */
    exists: (path: string) => boolean;
    /** Somewhere to mention a chosen directory that has gone missing. */
    warn?: (message: string) => void;
}

/**
 * The binary to run, in the order the sources are trusted:
 *
 * 1. **The environment.** An explicit instruction from whoever launched the
 *    process, and the developer escape hatch. It outranks the setting because
 *    it is the more deliberate of the two.
 * 2. **The user's chosen directory**, if it still holds the binary.
 * 3. **The one we ship.**
 *
 * Returns undefined when there is no bundled copy either, which leaves the API
 * to fall back to PATH and, failing that, to say ffmpeg is required.
 */
export function resolveFfmpegBinary(
    name: 'ffmpeg' | 'ffprobe',
    input: FfmpegLocationInput
): string | undefined {
    const fromEnv =
        name === 'ffmpeg' ? input.env.FFMPEG_PATH : input.env.FFPROBE_PATH;
    if (fromEnv) return fromEnv;

    if (input.ffmpegDir) {
        const filename = input.platform === 'win32' ? `${name}.exe` : name;
        const candidate = join(input.ffmpegDir, filename);
        if (input.exists(candidate)) return candidate;
        // Deleted, renamed, or on a drive that is not plugged in. Fall back
        // rather than fail to start — and the caller keeps the setting, because
        // the drive may well come back.
        input.warn?.(
            `Chosen ffmpeg directory has no ${filename}, using the bundled one: ${input.ffmpegDir}`
        );
    }

    return input.bundled(name);
}

/**
 * The two paths a candidate directory would be used through, for validating it
 * before it is saved. Same filename rule as {@link resolveFfmpegBinary}, so a
 * directory that validates is a directory that will resolve.
 */
export function candidateBinaries(
    dir: string,
    platform: NodeJS.Platform
): { ffmpeg: string; ffprobe: string } {
    const exe = platform === 'win32' ? '.exe' : '';
    return {
        ffmpeg: join(dir, `ffmpeg${exe}`),
        ffprobe: join(dir, `ffprobe${exe}`),
    };
}
