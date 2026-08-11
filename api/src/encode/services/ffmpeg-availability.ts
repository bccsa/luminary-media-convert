import { execFile } from 'child_process';
import { promisify } from 'util';
import { ffmpegBin, ffprobeBin } from './ffbin.js';

const execFileAsync = promisify(execFile);

/**
 * Where to send someone who has to install it. The official download page
 * rather than a platform-specific command, because the right command differs by
 * platform and the page covers all of them and stays correct as they change.
 */
export const FFMPEG_DOWNLOAD_URL = 'https://ffmpeg.org/download.html';

export interface BinaryStatus {
    /** What was actually spawned — `FFMPEG_PATH`/`FFPROBE_PATH`, else a bare name. */
    bin: string;
    /** Whether it ran. */
    present: boolean;
    /** First line of `-version`, when it ran. Recorded because version skew is a real support cost. */
    version?: string;
}

export interface FfmpegAvailability {
    ffmpeg: BinaryStatus;
    ffprobe: BinaryStatus;
    /** Both present. Nothing this app does works otherwise. */
    ok: boolean;
}

/** `ffmpeg version 7.1 Copyright…` → `7.1`; the whole line when it does not parse. */
function parseVersion(stdout: string): string {
    const first = stdout.split('\n', 1)[0]?.trim() ?? '';
    return /version\s+(\S+)/.exec(first)?.[1] ?? first;
}

async function probeOne(bin: string): Promise<BinaryStatus> {
    try {
        const { stdout } = await execFileAsync(bin, ['-version'], {
            timeout: 5000,
        });
        return { bin, present: true, version: parseVersion(stdout) };
    } catch {
        // Missing, not executable, or too slow to answer — all the same thing
        // from here: it cannot be relied on to encode.
        return { bin, present: false };
    }
}

/**
 * Whether ffmpeg and ffprobe can actually be run.
 *
 * Deliberately separate from `FfmpegService`'s acceleration detection, which
 * answers a different question and used to be asked instead of this one. Those
 * probes wrap `execSync` in `try/catch` and fall through to `'cpu'`, so a binary
 * that is not installed at all produced "No GPU found, using CPU encoding" — a
 * machine with nothing to encode with, reporting a working configuration. The
 * user then discovered it at the first encode, after choosing a destination in
 * the CMS and waiting for a probe.
 *
 * Presence and capability are two questions. This is the first one.
 */
export async function probeFfmpegBinaries(): Promise<FfmpegAvailability> {
    const [ffmpeg, ffprobe] = await Promise.all([
        probeOne(ffmpegBin()),
        probeOne(ffprobeBin()),
    ]);
    return { ffmpeg, ffprobe, ok: ffmpeg.present && ffprobe.present };
}

/**
 * Why this machine cannot encode, or null when it can.
 *
 * Written to be shown to whoever is sitting there: it names what is missing,
 * where it was looked for, and what to do about it. A packaged app ships both
 * binaries, so in practice this fires for a run from source with nothing
 * installed, or a package built without them (`pack` does not fetch them).
 */
export function missingBinariesMessage(
    availability: FfmpegAvailability
): string | null {
    if (availability.ok) return null;

    const missing = [
        !availability.ffmpeg.present ? availability.ffmpeg.bin : null,
        !availability.ffprobe.present ? availability.ffprobe.bin : null,
    ].filter((name): name is string => name !== null);

    const names = missing.join(' and ');
    const isPath = missing.some((name) => name.includes('/') || name.includes('\\'));

    return (
        `FFmpeg is required and could not be run: ${names} ` +
        `${missing.length > 1 ? 'were' : 'was'} not found. ` +
        (isPath
            ? 'The configured path does not point at a working executable. '
            : 'Install FFmpeg — which provides both ffmpeg and ffprobe — and make ' +
              'sure it is on your PATH. ') +
        `Then restart the app. Downloads: ${FFMPEG_DOWNLOAD_URL}`
    );
}
