/**
 * The parts of adding an audio track to an encoded video that are decided
 * rather than done: what each new rendition must match, and the FFmpeg command
 * that encodes them.
 */

/** What an existing audio group's renditions are, so the new track's matches them. */
export interface RenditionTarget {
    groupId: string;
    /** The new rendition's directory, beside the video's own. */
    dir: string;
    bitrateKbps: number;
    channels: number;
    sampleRate: number;
}

export interface AudioEncodePlan {
    inputPath: string;
    /** The source's audio stream, counted among its audio streams only (`0:a:<n>`). */
    sourceTrackIndex: number;
    /**
     * Where the source starts on the video's timeline, in seconds: positive when
     * it starts later than the video (silence is added before it), negative when
     * it starts earlier (its first seconds are dropped).
     */
    offsetSec: number;
    /** The video's length: the new track is cut, or padded with silence, to it. */
    durationSec: number;
    segmentDurationSec: number;
    renditions: RenditionTarget[];
    outputDir: string;
}

/** The bitrates the encoder's audio tiers use; an estimate is rounded to the nearest. */
const BITRATES_KBPS = [48, 64, 96, 128, 160, 192, 256, 320];

/**
 * An existing rendition's bitrate from its size and length. Its segments carry
 * container and encryption overhead, so the nearest of the encoder's own
 * bitrates is a better answer than the raw figure.
 */
export function estimateBitrateKbps(bytes: number, seconds: number): number {
    if (!(bytes > 0) || !(seconds > 0)) return 128;
    const kbps = (bytes * 8) / seconds / 1000;
    return BITRATES_KBPS.reduce((best, b) =>
        Math.abs(b - kbps) < Math.abs(best - kbps) ? b : best
    );
}

/**
 * A directory name for a new rendition that no existing one can have: the
 * encoder names its own `stream_<n>_<label>`, and a fresh token keeps two
 * tracks added the same day from meeting either.
 */
export function renditionDir(
    token: string,
    index: number,
    name: string
): string {
    const label = name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return `stream_add${token}_${index}${label ? `_${label}` : ''}`;
}

/**
 * The FFmpeg arguments that encode the source's audio into one rendition per
 * target, as the encoder's own audio renditions are muxed: AAC-LC, fMP4 HLS
 * segments of the video's length, each starting at the video's t=0.
 */
export function buildAddAudioArgs(plan: AudioEncodePlan): string[] {
    const n = plan.renditions.length;
    const chain: string[] = [];
    if (plan.offsetSec > 0) {
        chain.push(`adelay=delays=${Math.round(plan.offsetSec * 1000)}:all=1`);
    }
    // Padded, then cut at the video's end: the track lasts exactly as long.
    chain.push('apad', `atrim=end=${plan.durationSec}`, 'asetpts=PTS-STARTPTS');
    const splits = plan.renditions.map((_, i) => `[s${i}]`).join('');
    const filter = `[0:a:${plan.sourceTrackIndex}]${chain.join(',')},asplit=${n}${splits}`;

    const args = ['-hide_banner', '-y', '-nostats', '-progress', 'pipe:1'];
    if (plan.offsetSec < 0) args.push('-ss', String(-plan.offsetSec));
    args.push('-i', plan.inputPath, '-filter_complex', filter);
    plan.renditions.forEach((r, i) => {
        args.push(
            '-map',
            `[s${i}]`,
            `-c:a:${i}`,
            'aac',
            `-profile:a:${i}`,
            'aac_low',
            `-b:a:${i}`,
            `${r.bitrateKbps}k`,
            `-ac:a:${i}`,
            String(r.channels),
            `-ar:a:${i}`,
            String(r.sampleRate)
        );
    });
    args.push(
        '-f',
        'hls',
        '-hls_time',
        String(plan.segmentDurationSec),
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
        '-var_stream_map',
        plan.renditions.map((r, i) => `a:${i},name:${r.dir}`).join(' '),
        '-hls_segment_filename',
        `${plan.outputDir}/%v/segment_%05d.m4s`,
        `${plan.outputDir}/%v/playlist.m3u8`
    );
    return args;
}
