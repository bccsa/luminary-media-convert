import { execFile } from 'child_process';
import { promisify } from 'util';
import { ffmpegBin } from './ffbin.js';

const execFileAsync = promisify(execFile);

/**
 * Whether the FFmpeg on this machine is new enough to run this pipeline.
 *
 * **Asked as capabilities rather than as a version number, deliberately.** A
 * numeric floor has to encode a claim about which release added which flag, and
 * getting that wrong refuses an install that would have worked. It is also
 * routinely defeated by the version strings real builds report —
 * `4.4.2-0ubuntu0.22.04.1`, `7.1.1_2` from Homebrew, and `N-113140-gd12b0e6f4b`
 * from a nightly, which carries no version number at all and is newer than any
 * floor anyone would set. Asking the binary what it supports cannot be wrong
 * about either.
 *
 * The hardware flags (`scale_vt`, `h264_videotoolbox`, `scale_cuda`,
 * `h264_nvenc`) are deliberately absent: `FfmpegService` already probes those,
 * and an FFmpeg without them falls back to CPU rather than failing. These are
 * the ones the pipeline uses unconditionally, where absence is fatal.
 */
interface RequiredCapability {
    /** As the pipeline writes it, so a reader can find it in the code. */
    flag: string;
    /** Why it is needed — a bare flag name tells the reader nothing. */
    purpose: string;
    probe: 'hls-muxer' | 'mp4-muxer' | 'global-option';
    /** The token to look for in the probe's output. */
    token: string;
}

export const REQUIRED_CAPABILITIES: readonly RequiredCapability[] = [
    {
        flag: '-hls_segment_type fmp4',
        purpose: 'fMP4 segments',
        probe: 'hls-muxer',
        token: 'hls_segment_type',
    },
    {
        flag: '-hls_fmp4_init_filename',
        purpose: 'the fMP4 init segment',
        probe: 'hls-muxer',
        token: 'hls_fmp4_init_filename',
    },
    {
        flag: '-master_pl_name',
        purpose: 'writing master.m3u8',
        probe: 'hls-muxer',
        token: 'master_pl_name',
    },
    {
        flag: '-var_stream_map',
        purpose: 'multiple renditions and camera angles',
        probe: 'hls-muxer',
        token: 'var_stream_map',
    },
    {
        flag: '-movflags +negative_cts_offsets',
        purpose: 'B-frame timestamps in fMP4',
        probe: 'mp4-muxer',
        token: 'negative_cts_offsets',
    },
    {
        flag: '-stats_period',
        purpose: 'encode progress reporting',
        probe: 'global-option',
        token: 'stats_period',
    },
];

/**
 * The version to tell a user to install.
 *
 * Established from FFmpeg's own source rather than from memory, by reading each
 * required option at release tags: `-stats_period` is absent in `n4.3` and
 * present in `n4.4` (`fftools/ffmpeg_opt.c`), which makes it the binding
 * constraint. Everything else the pipeline uses unconditionally was in by `n4.0`
 * — the HLS options in `libavformat/hlsenc.c`, `negative_cts_offsets` in
 * `libavformat/movenc.c`.
 *
 * **This number is for telling people what to install, not for deciding whether
 * to let them.** That decision is made by probing the binary, because version
 * strings cannot be trusted to order: real builds report
 * `4.4.2-0ubuntu0.22.04.1`, `7.1.1_2` from Homebrew, and `N-113140-gd12b0e6f4b`
 * from a nightly, which carries no version at all and is newer than any floor.
 * Comparing those is how a working install gets refused.
 */
export const MIN_FFMPEG_VERSION = '4.4';

export interface CapabilityReport {
    /** Capabilities this FFmpeg does not have. */
    missing: RequiredCapability[];
    /**
     * True when a probe could not be run at all, so `missing` proves nothing.
     * A probe that fails is not evidence of an old build, and refusing on it
     * would turn an unreadable answer into a broken app.
     */
    indeterminate: boolean;
}

/** `ffmpeg -h muxer=<name>`, or null when it cannot be read. */
async function muxerHelp(name: string): Promise<string | null> {
    try {
        const { stdout, stderr } = await execFileAsync(
            ffmpegBin(),
            ['-hide_banner', '-h', `muxer=${name}`],
            { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }
        );
        return stdout + stderr;
    } catch {
        return null;
    }
}

/**
 * Whether ffmpeg accepts a global option, without encoding anything.
 *
 * Argument parsing happens before ffmpeg complains about having no output file,
 * so an unknown option answers `Unrecognized option '<name>'` while a known one
 * gets as far as the missing-output error. Cheaper and more direct than reading
 * `-h full`, whose output is a megabyte.
 */
async function acceptsGlobalOption(token: string): Promise<boolean | null> {
    let output: string;
    try {
        const { stdout, stderr } = await execFileAsync(
            ffmpegBin(),
            ['-hide_banner', `-${token}`, '1'],
            { timeout: 10_000 }
        );
        output = stdout + stderr;
    } catch (err) {
        // Expected: no output file was given, so ffmpeg exits non-zero. What
        // matters is which complaint it made.
        const e = err as { stdout?: string; stderr?: string; code?: unknown };
        if (e.stdout === undefined && e.stderr === undefined) return null;
        output = (e.stdout ?? '') + (e.stderr ?? '');
    }
    if (output.includes(`Unrecognized option '${token}'`)) return false;
    if (output.includes('Unrecognized option')) return false;
    return true;
}

/** What this FFmpeg is missing of what the pipeline needs unconditionally. */
export async function probeFfmpegCapabilities(): Promise<CapabilityReport> {
    const needsHls = REQUIRED_CAPABILITIES.some((c) => c.probe === 'hls-muxer');
    const needsMp4 = REQUIRED_CAPABILITIES.some((c) => c.probe === 'mp4-muxer');

    const [hls, mp4] = await Promise.all([
        needsHls ? muxerHelp('hls') : Promise.resolve(''),
        needsMp4 ? muxerHelp('mp4') : Promise.resolve(''),
    ]);

    let indeterminate = hls === null || mp4 === null;
    const missing: RequiredCapability[] = [];

    for (const capability of REQUIRED_CAPABILITIES) {
        if (capability.probe === 'hls-muxer') {
            if (hls && !hls.includes(capability.token))
                missing.push(capability);
        } else if (capability.probe === 'mp4-muxer') {
            if (mp4 && !mp4.includes(capability.token))
                missing.push(capability);
        } else {
            const accepted = await acceptsGlobalOption(capability.token);
            if (accepted === null) indeterminate = true;
            else if (!accepted) missing.push(capability);
        }
    }

    return { missing, indeterminate };
}

/**
 * Why this FFmpeg is too old to use, or null when it will do.
 *
 * Says the one thing the reader can act on — install a newer FFmpeg, and which
 * version — because the person who sees this is trying to convert a video, not
 * debug a muxer. Which options are missing goes to {@link capabilityDetail} for
 * the log, where the reader is us.
 */
export function unsupportedCapabilitiesMessage(
    report: CapabilityReport,
    version?: string
): string | null {
    if (report.missing.length === 0) return null;

    return (
        `The installed FFmpeg is too old` +
        (version ? ` (version ${version})` : '') +
        `. Luminary Media Convert needs FFmpeg ${MIN_FFMPEG_VERSION} or newer. ` +
        `Install a newer version, then start the app again.`
    );
}

/**
 * The same finding for the log: which options were missing and what each is for.
 *
 * Kept out of the user-facing message and kept at all, because "too old" alone
 * is not diagnosable — when a build fails this check unexpectedly, this line is
 * what says which option it lacked.
 */
export function capabilityDetail(report: CapabilityReport): string | null {
    if (report.missing.length === 0) return null;
    const listed = report.missing
        .map((c) => `${c.flag} (${c.purpose})`)
        .join(', ');
    return `Unsupported by this FFmpeg: ${listed}`;
}
