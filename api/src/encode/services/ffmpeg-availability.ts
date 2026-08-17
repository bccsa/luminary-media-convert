import { execFile } from 'child_process';
import { promisify } from 'util';
import { ffmpegBin, ffprobeBin } from './ffbin.js';
import {
    capabilityDetail,
    MIN_FFMPEG_VERSION,
    probeFfmpegCapabilities,
    unsupportedCapabilitiesMessage,
} from './ffmpeg-capabilities.js';

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

    // A configured path that does not work is a different problem with a
    // different fix, and telling that reader to install what they already have
    // sends them the wrong way. They are also the only reader who needs a path.
    const badPath = missing.find(
        (name) => name.includes('/') || name.includes('\\')
    );
    if (badPath) {
        return (
            `FFmpeg could not be run: ${badPath} is not a working executable. ` +
            `Luminary Media Convert needs FFmpeg ${MIN_FFMPEG_VERSION} or newer.`
        );
    }

    return (
        `FFmpeg is not installed. Luminary Media Convert needs FFmpeg ` +
        `${MIN_FFMPEG_VERSION} or newer to read, preview and encode video. ` +
        `Install it, then start the app again.`
    );
}

/**
 * Which of the two binaries could not be run, for the log.
 *
 * The user-facing message deliberately says only "FFmpeg is not installed",
 * because one package provides both and the fix is the same either way. Half
 * installed is a real state though — a partial package, or a PATH with one of
 * them — and it should not take a debugger to find out which half.
 */
export function missingBinariesDetail(
    availability: FfmpegAvailability
): string | null {
    if (availability.ok) return null;
    const missing = [
        !availability.ffmpeg.present ? availability.ffmpeg.bin : null,
        !availability.ffprobe.present ? availability.ffprobe.bin : null,
    ].filter((name): name is string => name !== null);
    return `Could not run: ${missing.join(', ')}`;
}

export interface FfmpegCheck {
    availability: FfmpegAvailability;
    /**
     * Why this machine cannot encode, or null when it can. Written for whoever
     * is sitting there: what is wrong and what to install, no option names.
     */
    reason: string | null;
    /**
     * The same finding for the log — which options were missing. Null when the
     * problem is an absent binary, where there is nothing more to say.
     */
    detail: string | null;
}

/**
 * The one question both the API and its host need answered: is the FFmpeg on
 * this machine usable?
 *
 * Two checks in order, because the answers are not interchangeable. Absent comes
 * first — telling someone their FFmpeg is too old when they have none would send
 * them looking for an upgrade they cannot perform. Only then, whether the one
 * they have supports what the pipeline uses unconditionally.
 *
 * Exists so the orchestration lives in one place. The host shows the verdict and
 * the API enforces it, and two copies of "presence, then capability" would
 * eventually disagree about which came first or what counted.
 */
export async function checkFfmpeg(): Promise<FfmpegCheck> {
    const availability = await probeFfmpegBinaries();

    const absent = missingBinariesMessage(availability);
    if (absent) {
        return {
            availability,
            reason: absent,
            detail: missingBinariesDetail(availability),
        };
    }

    const report = await probeFfmpegCapabilities();
    return {
        availability,
        reason: unsupportedCapabilitiesMessage(
            report,
            availability.ffmpeg.version
        ),
        detail: capabilityDetail(report),
    };
}
