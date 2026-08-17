import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
    capabilityDetail,
    MIN_FFMPEG_VERSION,
    probeFfmpegCapabilities,
    REQUIRED_CAPABILITIES,
    unsupportedCapabilitiesMessage,
} from './ffmpeg-capabilities.js';
import { checkFfmpeg } from './ffmpeg-availability.js';

/**
 * Nobody here has a genuinely old FFmpeg to test against, and the check is
 * worthless if it has only ever seen a new one. These fixtures are shell scripts
 * that answer the three probes the way a real build does — including an old one,
 * which is the case that matters and the one a passing test on this machine
 * would otherwise never exercise.
 */
const MODERN_HLS_HELP = `Muxer hls [Apple HTTP Live Streaming]:
    Common options:
    -f                 <string>
    HLS muxer AVOptions:
    -hls_time          <duration>
    -hls_segment_type  <int>
    -hls_fmp4_init_filename <string>
    -master_pl_name    <string>
    -var_stream_map    <string>
    -hls_flags         <flags>
`;

/** FFmpeg 3.x-era: fMP4 and per-variant mapping had not arrived. */
const ANCIENT_HLS_HELP = `Muxer hls [Apple HTTP Live Streaming]:
    Common options:
    -f                 <string>
    HLS muxer AVOptions:
    -hls_time          <duration>
    -hls_flags         <flags>
`;

const MODERN_MP4_HELP = `Muxer mp4 [MP4 (MPEG-4 Part 14)]:
    -movflags          <flags>
        faststart
        negative_cts_offsets
`;

const ANCIENT_MP4_HELP = `Muxer mp4 [MP4 (MPEG-4 Part 14)]:
    -movflags          <flags>
        faststart
`;

interface FakeSpec {
    version: string;
    hlsHelp: string;
    mp4Help: string;
    /** Whether `-stats_period` is a known global option. */
    statsPeriod: boolean;
}

let dir: string;
const ORIGINAL = process.env.FFMPEG_PATH;

/** Write a fake ffmpeg that answers the probes as `spec` describes. */
function fakeFfmpeg(spec: FakeSpec): string {
    const path = join(dir, `ffmpeg-${Math.abs(hash(JSON.stringify(spec)))}`);
    const script = `#!/bin/sh
# Drop the -hide_banner the probes pass, so $1 is the interesting argument.
[ "$1" = "-hide_banner" ] && shift
case "$1" in
  -version)
    echo "ffmpeg version ${spec.version} Copyright (c) 2000-2020 the FFmpeg developers"
    exit 0 ;;
  -h)
    case "$2" in
      muxer=hls) cat <<'HLS'
${spec.hlsHelp}HLS
        exit 0 ;;
      muxer=mp4) cat <<'MP4'
${spec.mp4Help}MP4
        exit 0 ;;
    esac
    exit 0 ;;
  -stats_period)
    ${
        spec.statsPeriod
            ? 'echo "ffmpeg stats and -progress period set to 1." >&2; echo "At least one output file must be specified" >&2; exit 1'
            : `echo "Unrecognized option 'stats_period'." >&2; exit 1`
    } ;;
esac
echo "At least one output file must be specified" >&2
exit 1
`;
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return path;
}

/** Stable filename per spec, so a fixture is not rewritten mid-test. */
function hash(s: string): number {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return h;
}

const MODERN: FakeSpec = {
    version: '8.1',
    hlsHelp: MODERN_HLS_HELP,
    mp4Help: MODERN_MP4_HELP,
    statsPeriod: true,
};

describe('probeFfmpegCapabilities', () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'luminary-ffcap-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (ORIGINAL === undefined) delete process.env.FFMPEG_PATH;
        else process.env.FFMPEG_PATH = ORIGINAL;
    });

    it('finds nothing missing on a build that supports everything', async () => {
        process.env.FFMPEG_PATH = fakeFfmpeg(MODERN);

        const report = await probeFfmpegCapabilities();

        expect(report.missing).toEqual([]);
        expect(report.indeterminate).toBe(false);
    });

    it('catches an old build, naming every flag it lacks', async () => {
        // The case this check exists for, and the one no test on a developer
        // machine would reach without a fixture.
        process.env.FFMPEG_PATH = fakeFfmpeg({
            version: '3.4.8',
            hlsHelp: ANCIENT_HLS_HELP,
            mp4Help: ANCIENT_MP4_HELP,
            statsPeriod: false,
        });

        const report = await probeFfmpegCapabilities();
        const flags = report.missing.map((c) => c.flag);

        expect(flags).toContain('-hls_segment_type fmp4');
        expect(flags).toContain('-hls_fmp4_init_filename');
        expect(flags).toContain('-master_pl_name');
        expect(flags).toContain('-var_stream_map');
        expect(flags).toContain('-movflags +negative_cts_offsets');
        expect(flags).toContain('-stats_period');
    });

    it('catches a build missing only the newest flag', async () => {
        // A 4.0-era build: HLS is all there, `-stats_period` is not. Partial
        // support is the likely real-world case, not all-or-nothing.
        process.env.FFMPEG_PATH = fakeFfmpeg({
            ...MODERN,
            version: '4.0.6',
            statsPeriod: false,
        });

        const report = await probeFfmpegCapabilities();

        expect(report.missing.map((c) => c.flag)).toEqual(['-stats_period']);
    });

    it('treats an unreadable probe as indeterminate, not as missing', async () => {
        // A probe that cannot run is not evidence of an old build. Blocking on
        // it would turn an unanswerable question into a broken app.
        process.env.FFMPEG_PATH = join(dir, 'does-not-exist');

        const report = await probeFfmpegCapabilities();

        expect(report.indeterminate).toBe(true);
        expect(report.missing).toEqual([]);
    });
});

describe('unsupportedCapabilitiesMessage', () => {
    it('says nothing when nothing is missing', () => {
        expect(
            unsupportedCapabilitiesMessage({
                missing: [],
                indeterminate: false,
            })
        ).toBeNull();
    });

    it('tells the user the version to install, not the option that failed', () => {
        /*
         * The check is capability-based because version strings cannot be
         * trusted to order — but the message has to be actionable, and "your
         * FFmpeg lacks -var_stream_map" is not something a person installs their
         * way out of. So: what is wrong, which version, and the version they
         * have, for the support conversation.
         */
        const report = {
            missing: [
                REQUIRED_CAPABILITIES.filter(
                    (c) => c.flag === '-var_stream_map'
                )[0]!,
            ],
            indeterminate: false,
        };

        const message = unsupportedCapabilitiesMessage(report, '4.0.6');

        expect(message).toContain('too old');
        expect(message).toContain('4.0.6');
        expect(message).toContain(MIN_FFMPEG_VERSION);
        expect(message).not.toContain('-var_stream_map');
    });

    it('still says what failed, in the log detail', () => {
        // Dropped from the user's message, not lost: when a build fails this
        // check unexpectedly, this is the line that says which option it lacked.
        const detail = capabilityDetail({
            missing: [
                REQUIRED_CAPABILITIES.filter(
                    (c) => c.flag === '-var_stream_map'
                )[0]!,
            ],
            indeterminate: false,
        });

        expect(detail).toContain('-var_stream_map');
        expect(detail).toContain('multiple renditions and camera angles');
    });

    it('says nothing in the detail when nothing is missing', () => {
        expect(
            capabilityDetail({ missing: [], indeterminate: false })
        ).toBeNull();
    });
});

describe('checkFfmpeg', () => {
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'luminary-ffcheck-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
        if (ORIGINAL === undefined) delete process.env.FFMPEG_PATH;
        else process.env.FFMPEG_PATH = ORIGINAL;
        delete process.env.FFPROBE_PATH;
    });

    it('reports absence rather than age when there is no binary', async () => {
        // Order matters: telling someone their FFmpeg is too old when they have
        // none sends them looking for an upgrade they cannot perform.
        process.env.FFMPEG_PATH = join(dir, 'nope');
        process.env.FFPROBE_PATH = join(dir, 'nope');

        const { reason } = await checkFfmpeg();

        // Configured paths that do not resolve get the configuration message
        // rather than the install one; what matters here is that neither of them
        // is the "too old" message, which would send the reader to upgrade
        // something that is not there to upgrade.
        expect(reason).toContain('not a working executable');
        expect(reason).not.toContain('too old');
    });

    it('reports age when the binaries are there but too old', async () => {
        const old = fakeFfmpeg({
            version: '3.4.8',
            hlsHelp: ANCIENT_HLS_HELP,
            mp4Help: ANCIENT_MP4_HELP,
            statsPeriod: false,
        });
        process.env.FFMPEG_PATH = old;
        process.env.FFPROBE_PATH = old;

        const { reason } = await checkFfmpeg();

        expect(reason).toContain('too old');
        expect(reason).toContain('3.4.8');
    });

    it('passes a build that has everything', async () => {
        const modern = fakeFfmpeg(MODERN);
        process.env.FFMPEG_PATH = modern;
        process.env.FFPROBE_PATH = modern;

        const { reason, availability } = await checkFfmpeg();

        expect(reason).toBeNull();
        expect(availability.ffmpeg.version).toBe('8.1');
    });
});
