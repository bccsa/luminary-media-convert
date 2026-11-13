import type {
    AudioTrackInfo,
    ProbeResult,
    VideoTrackInfo,
} from '@luminary-media-converter/encode-config';

/**
 * What this browser can do beyond the codecs every Chromium plays. Injected
 * rather than read inside {@link previewPlayability}, so the rule can be tested
 * against browsers other than the one running the test.
 */
export interface PlaybackCapabilities {
    /** 8-bit HEVC decodes here (a platform decoder: Chromium has none of its own). */
    hevc: boolean;
    /** 10-bit HEVC decodes here. */
    hevc10: boolean;
    /** Media elements list a file's audio tracks, so a second one can be switched to. */
    audioTrackSwitching: boolean;
}

export interface PreviewPlayability {
    /** The browser can play the source file as it is, every stream of it. */
    direct: boolean;
    /** Why not, in a few words for the "Converted preview" label. */
    reason?: string;
}

/** What the browser running this page can do; read once, it does not change. */
export function detectPlaybackCapabilities(): PlaybackCapabilities {
    const video =
        typeof document !== 'undefined'
            ? document.createElement('video')
            : null;
    const canPlay = (type: string): boolean => {
        try {
            return !!video && video.canPlayType(type) !== '';
        } catch {
            return false;
        }
    };
    const prototype =
        typeof HTMLMediaElement !== 'undefined'
            ? HTMLMediaElement.prototype
            : null;
    return {
        hevc: canPlay('video/mp4; codecs="hvc1.1.6.L93.B0"'),
        hevc10: canPlay('video/mp4; codecs="hvc1.2.4.L93.B0"'),
        audioTrackSwitching: !!prototype && 'audioTracks' in prototype,
    };
}

/**
 * The containers a browser plays a file from, by ffprobe's demuxer name, and
 * the audio each one is trusted to carry.
 *
 * Audio is listed per container, and strictly, for a reason video is not: a
 * browser that cannot decode a file's audio plays the picture in silence and
 * reports nothing, so a wrong entry here is a preview that is quietly muted. A
 * picture it cannot decode does at least leave the frame without a size, which
 * the player checks for, so an unplayable video falls back on its own. Anything
 * missing here only costs a converted preview, never a broken one, so a pairing
 * goes in once it has been heard to play.
 */
const CONTAINERS: {
    /** Any of ffprobe's comma-separated names for the demuxer. */
    names: string[];
    video: Set<string>;
    audio: Set<string>;
}[] = [
    {
        // MP4, MOV, M4A: ffprobe has one demuxer for the family.
        names: ['mov', 'mp4', 'm4a'],
        video: new Set(['h264', 'hevc', 'av1', 'vp9']),
        audio: new Set(['aac', 'mp3', 'opus', 'flac']),
    },
    {
        names: ['matroska', 'webm'],
        video: new Set(['vp8', 'vp9', 'av1']),
        audio: new Set(['opus', 'vorbis']),
    },
    {
        names: ['ogg'],
        video: new Set(),
        audio: new Set(['opus', 'vorbis', 'flac']),
    },
    { names: ['mp3'], video: new Set(), audio: new Set(['mp3']) },
    {
        names: ['wav'],
        video: new Set(),
        audio: new Set(['pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']),
    },
    { names: ['flac'], video: new Set(), audio: new Set(['flac']) },
    { names: ['aac'], video: new Set(), audio: new Set(['aac']) },
];

const CONTAINER_LABELS: Record<string, string> = {
    mov: 'MOV',
    matroska: 'MKV',
    mpegts: 'MPEG-TS',
    avi: 'AVI',
    asf: 'WMV',
    mxf: 'MXF',
    flv: 'FLV',
    mpeg: 'MPEG-PS',
    aiff: 'AIFF',
};

const CODEC_LABELS: Record<string, string> = {
    h264: 'H.264',
    hevc: 'HEVC',
    av1: 'AV1',
    vp8: 'VP8',
    vp9: 'VP9',
    prores: 'ProRes',
    dnxhd: 'DNxHD',
    mpeg2video: 'MPEG-2',
    mpeg1video: 'MPEG-1',
    mpeg4: 'MPEG-4 Part 2',
    mjpeg: 'Motion JPEG',
    wmv1: 'WMV',
    wmv2: 'WMV',
    wmv3: 'WMV',
    vc1: 'VC-1',
    theora: 'Theora',
    aac: 'AAC',
    mp3: 'MP3',
    mp2: 'MP2',
    ac3: 'AC-3',
    eac3: 'E-AC-3',
    dts: 'DTS',
    truehd: 'TrueHD',
    alac: 'ALAC',
    opus: 'Opus',
    vorbis: 'Vorbis',
    flac: 'FLAC',
    wmav2: 'WMA',
    wmapro: 'WMA',
};

function codecLabel(codec: string): string {
    if (codec.startsWith('pcm_')) return 'PCM';
    return CODEC_LABELS[codec] ?? codec.toUpperCase();
}

/** Pixel formats a browser decodes, per codec: 4:2:0 throughout, 8-bit unless named. */
const EIGHT_BIT_420 = new Set(['yuv420p', 'yuvj420p']);
const TEN_BIT_420 = new Set(['yuv420p10le']);

/** Why this video stream will not play in this browser, or null when it will. */
function videoProblem(
    track: VideoTrackInfo,
    allowed: Set<string>,
    caps: PlaybackCapabilities
): string | null {
    const codec = track.codec;
    if (!allowed.has(codec)) return `${codecLabel(codec)} video`;
    const pixFmt = track.pixFmt;
    const eightBit = !!pixFmt && EIGHT_BIT_420.has(pixFmt);
    const tenBit = !!pixFmt && TEN_BIT_420.has(pixFmt);
    switch (codec) {
        case 'h264':
            // High 10 and 4:2:2 are H.264 too, and no browser decodes them.
            return eightBit ? null : `${pixFmtLabel(pixFmt)} H.264 video`;
        case 'hevc':
            if (eightBit && caps.hevc) return null;
            if (tenBit && caps.hevc10) return null;
            return eightBit || tenBit
                ? 'HEVC video'
                : `${pixFmtLabel(pixFmt)} HEVC video`;
        case 'vp9':
        case 'av1':
            return eightBit || tenBit
                ? null
                : `${pixFmtLabel(pixFmt)} ${codecLabel(codec)} video`;
        default:
            return eightBit ? null : `${pixFmtLabel(pixFmt)} ${codecLabel(codec)} video`;
    }
}

function pixFmtLabel(pixFmt: string | undefined): string {
    if (!pixFmt) return 'Unknown-format';
    if (/10(le|be)$/.test(pixFmt)) return '10-bit';
    if (/12(le|be)$/.test(pixFmt)) return '12-bit';
    if (pixFmt.startsWith('yuv422')) return '4:2:2';
    if (pixFmt.startsWith('yuv444')) return '4:4:4';
    return pixFmt;
}

function audioProblem(
    track: AudioTrackInfo,
    allowed: Set<string>
): string | null {
    return allowed.has(track.codec) ? null : `${codecLabel(track.codec)} audio`;
}

/**
 * Can the preview play the source file itself, straight off the disk, with no
 * FFmpeg in between?
 *
 * Only when the container and every stream that would be played are ones this
 * browser decodes — the alternative to a wrong yes is a picture without sound,
 * which nobody notices until the encode has the same silence in it. A no is a
 * converted preview, which costs a little CPU and a label saying why.
 *
 * Every video stream is checked, not only the first, because a file's other
 * cameras play directly too (as angles) where the browser can switch to them,
 * and where it cannot, the converted preview would show only the first camera
 * as well. Every audio stream likewise; and a file with more than one needs a
 * browser that can switch between them, or the extra ones could not be heard.
 */
export function previewPlayability(
    probe: ProbeResult,
    caps: PlaybackCapabilities
): PreviewPlayability {
    // A probe from before the API reported every field can lack any of them.
    const names = (probe.format?.formatName ?? '').split(',');
    const container = CONTAINERS.find((candidate) =>
        candidate.names.some((name) => names.includes(name))
    );
    if (!container) {
        const name = names[0] ?? '';
        const label = CONTAINER_LABELS[name] ?? name.toUpperCase();
        return {
            direct: false,
            reason: label ? `${label} container` : 'unknown container',
        };
    }

    const videos = probe.videoTracks;
    const audios = probe.audioTracks;
    if (videos.length === 0 && audios.length === 0) {
        return { direct: false, reason: 'no playable streams' };
    }

    for (const track of videos) {
        const problem = videoProblem(track, container.video, caps);
        if (problem) return { direct: false, reason: problem };
    }
    for (const track of audios) {
        const problem = audioProblem(track, container.audio);
        if (problem) return { direct: false, reason: problem };
    }

    if (audios.length > 1 && !caps.audioTrackSwitching) {
        return { direct: false, reason: 'several audio tracks' };
    }

    return { direct: true };
}
