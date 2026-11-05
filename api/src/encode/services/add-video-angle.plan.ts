/**
 * The parts of adding a camera angle to an encoded video that are decided
 * rather than done: what each new rendition must match, and the FFmpeg command
 * that encodes them.
 */
import { ladderVideoArgs, type AccelMode } from './encoder-selection.js';

/** One size of the existing angle, which the new angle gets a rendition of. */
export interface AngleRenditionTarget {
    /** The new rendition's directory, beside the video's own. */
    dir: string;
    width: number;
    height: number;
    videoBitrateKbps: number;
    /** The existing variant's URI, relative to the master. */
    referenceUri: string;
}

export interface VideoAnglePlan {
    inputPath: string;
    /** The source's video stream, counted among its video streams (`0:v:<n>`). */
    sourceTrackIndex: number;
    /**
     * Where the source starts on the video's timeline, in seconds: positive when
     * it starts later (black is shown before it), negative when it starts
     * earlier (its first seconds are dropped).
     */
    offsetSec: number;
    /** The video's length: the angle is cut, or held on black, to it. */
    durationSec: number;
    segmentDurationSec: number;
    frameRate: number;
    accelMode: AccelMode;
    renditions: AngleRenditionTarget[];
    outputDir: string;
    /** FFmpeg's own master, read for each rendition's CODECS and BANDWIDTH, then discarded. */
    masterName: string;
}

/**
 * A directory name for a new rendition that no existing one can have: the
 * encoder names its own `stream_<n>_<label>`, and a fresh token keeps two
 * angles added the same day from meeting either.
 */
export function angleRenditionDir(
    token: string,
    index: number,
    name: string,
    height: number
): string {
    const label = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return `stream_add${token}_${index}${label ? `_${label}` : ''}_${height}p`;
}

/**
 * An existing rendition's video bitrate from its size and length, rounded to
 * 50 kbps: its segments carry container and encryption overhead, so the
 * figure is a target, not a measurement to copy to the kilobit.
 */
export function estimateVideoBitrateKbps(
    bytes: number,
    seconds: number
): number {
    if (!(bytes > 0) || !(seconds > 0)) return 2000;
    const kbps = (bytes * 8) / seconds / 1000;
    return Math.max(100, Math.round(kbps / 50) * 50);
}

/**
 * The FFmpeg arguments that encode the source's picture into one rendition
 * per target, as the encoder's own ladder is muxed: H.264, fMP4 HLS segments
 * of the video's length with a keyframe on every segment boundary, each
 * starting at the video's t=0. A source of another shape is fitted inside
 * each size on black, never stretched.
 *
 * Decoded and filtered on the CPU whatever the encoder: the padding and frame
 * rate filters have no hardware counterpart, and every hardware encoder takes
 * frames from memory.
 */
export function buildAddAngleArgs(plan: VideoAnglePlan): string[] {
    const n = plan.renditions.length;
    const seg = plan.segmentDurationSec;
    const fps = plan.frameRate;
    const gop = Math.max(1, Math.round(seg * fps));
    const pixFmt = plan.accelMode === 'cpu' ? 'yuv420p' : 'nv12';

    const head = [
        `fps=${fps}`,
        // Black before a late start and after an early end; trimmed to the video's length.
        `tpad=${plan.offsetSec > 0 ? `start_duration=${plan.offsetSec}:` : ''}stop_mode=add:stop_duration=${plan.durationSec}:color=black`,
        `trim=end=${plan.durationSec}`,
        'setpts=PTS-STARTPTS',
    ];
    const splits = plan.renditions.map((_, i) => `[s${i}]`).join('');
    const parts = [
        `[0:v:${plan.sourceTrackIndex}]${head.join(',')},split=${n}${splits}`,
        ...plan.renditions.map(
            (r, i) =>
                `[s${i}]scale=${r.width}:${r.height}:force_original_aspect_ratio=decrease,` +
                `pad=${r.width}:${r.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=${pixFmt}[v${i}]`
        ),
    ];

    const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
    if (plan.offsetSec < 0) args.push('-ss', String(-plan.offsetSec));
    args.push('-i', plan.inputPath, '-filter_complex', parts.join(';'));
    plan.renditions.forEach((r, i) => {
        args.push(
            '-map',
            `[v${i}]`,
            ...ladderVideoArgs(
                plan.accelMode,
                {
                    width: r.width,
                    height: r.height,
                    videoBitrateKbps: r.videoBitrateKbps,
                },
                i,
                fps
            ),
            `-g:v:${i}`,
            String(gop),
            `-keyint_min:v:${i}`,
            String(gop),
            // The segment grid, whatever the encoder's own scene-cut choices.
            `-force_key_frames:v:${i}`,
            `expr:gte(t,n_forced*${seg})`
        );
    });
    args.push(
        '-an',
        '-f',
        'hls',
        '-hls_time',
        String(seg),
        '-hls_playlist_type',
        'vod',
        '-hls_flags',
        'independent_segments',
        '-hls_segment_type',
        'fmp4',
        '-hls_fmp4_init_filename',
        'init.mp4',
        '-movflags',
        '+negative_cts_offsets+default_base_moof',
        '-master_pl_name',
        plan.masterName,
        '-var_stream_map',
        plan.renditions.map((r, i) => `v:${i},name:${r.dir}`).join(' '),
        '-hls_segment_filename',
        `${plan.outputDir}/%v/segment_%05d.m4s`,
        `${plan.outputDir}/%v/playlist.m3u8`
    );
    return args;
}

/**
 * The CODECS of a new variant: its own video codec, then the existing
 * variant's other codecs (its audio), which the new angle shares.
 */
export function angleCodecs(
    videoCodecs: string,
    referenceCodecs?: string
): string {
    const isVideo = (c: string) => /^(avc|hvc|hev|av01|vp0)/.test(c.trim());
    const video = videoCodecs
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c && isVideo(c));
    const others = (referenceCodecs ?? '')
        .split(',')
        .map((c) => c.trim())
        .filter((c) => c && !isVideo(c));
    return [...video, ...others].join(',');
}
