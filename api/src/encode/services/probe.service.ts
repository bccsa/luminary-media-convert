import { Injectable, Logger } from '@nestjs/common';
import { execSync } from 'child_process';

export interface VideoTrackInfo {
    index: number;
    codec: string;
    width: number;
    height: number;
    bitrateKbps: number;
    frameRate: number;
    profile?: string;
    language?: string;
    title?: string;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    bitrateKbps: number;
    channels: number;
    sampleRate: number;
    language?: string;
    title?: string;
}

export interface ProbeResult {
    format: {
        duration: number;
        bitrateKbps: number;
        formatName: string;
    };
    videoTracks: VideoTrackInfo[];
    audioTracks: AudioTrackInfo[];
}

export interface SuggestedVideoRendition {
    width: number;
    height: number;
    videoBitrateKbps: number;
    copyStream: boolean;
    sourceTrackIndex?: number;
    audioGroupId: string;
    label?: string;
}

export interface SuggestedAudioGroup {
    id: string;
    label?: string;
    audioBitrateKbps: number;
    channels: number;
    audioCodec: 'aac' | 'mp3';
    sourceTrackIndex: number;
    language?: string;
    copyStream?: boolean;
}

export interface SuggestedAudioRendition {
    audioBitrateKbps: number;
    channels: number;
    audioCodec: 'aac' | 'mp3';
    sourceTrackIndex: number;
    language?: string;
    label?: string;
    copyStream?: boolean;
}

export interface SuggestedConfig {
    type: 'video' | 'audio';
    segmentDuration: number;
    videoRenditions?: SuggestedVideoRendition[];
    audioGroups?: SuggestedAudioGroup[];
    audioRenditions?: SuggestedAudioRendition[];
}

interface FfprobeStream {
    index: number;
    codec_type: string;
    codec_name?: string;
    width?: number;
    height?: number;
    bit_rate?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    profile?: string;
    channels?: number;
    sample_rate?: string;
    tags?: Record<string, string>;
}

interface FfprobeFormat {
    duration?: string;
    bit_rate?: string;
    format_name?: string;
}

interface FfprobeOutput {
    streams: FfprobeStream[];
    format: FfprobeFormat;
}

const ABR_LADDER: { height: number; width: number; bitrateKbps: number; label: string }[] = [
    { height: 2160, width: 3840, bitrateKbps: 15000, label: '4K' },
    { height: 1440, width: 2560, bitrateKbps: 8000, label: '1440p' },
    { height: 1080, width: 1920, bitrateKbps: 5000, label: '1080p' },
    { height: 720, width: 1280, bitrateKbps: 2500, label: '720p' },
    { height: 480, width: 854, bitrateKbps: 1000, label: '480p' },
    { height: 360, width: 640, bitrateKbps: 600, label: '360p' },
    { height: 240, width: 426, bitrateKbps: 300, label: '240p' },
    { height: 144, width: 256, bitrateKbps: 150, label: '144p' },
];

const AUDIO_GROUP_TIERS: { minHeight: number; groupId: string; label: string; bitrateKbps: number; channels: number }[] = [
    { minHeight: 720, groupId: 'hd', label: 'HD Audio', bitrateKbps: 192, channels: 2 },
    { minHeight: 360, groupId: 'mid', label: 'Standard Audio', bitrateKbps: 128, channels: 2 },
    { minHeight: 0, groupId: 'low', label: 'Low Audio', bitrateKbps: 64, channels: 1 },
];

@Injectable()
export class ProbeService {
    private readonly logger = new Logger(ProbeService.name);

    probe(filePath: string): ProbeResult {
        const raw = execSync(
            `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
            { encoding: 'utf-8', timeout: 60000 },
        );

        const data: FfprobeOutput = JSON.parse(raw);

        const videoTracks: VideoTrackInfo[] = [];
        const audioTracks: AudioTrackInfo[] = [];

        let videoStreamIndex = 0;
        let audioStreamIndex = 0;

        for (const s of data.streams) {
            if (s.codec_type === 'video') {
                videoTracks.push({
                    index: videoStreamIndex++,
                    codec: s.codec_name ?? 'unknown',
                    width: s.width ?? 0,
                    height: s.height ?? 0,
                    bitrateKbps: s.bit_rate ? Math.round(parseInt(s.bit_rate, 10) / 1000) : 0,
                    frameRate: this.parseFrameRate(s.avg_frame_rate ?? s.r_frame_rate ?? '0/1'),
                    profile: s.profile,
                    language: s.tags?.language,
                    title: s.tags?.title,
                });
            } else if (s.codec_type === 'audio') {
                audioTracks.push({
                    index: audioStreamIndex++,
                    codec: s.codec_name ?? 'unknown',
                    bitrateKbps: s.bit_rate ? Math.round(parseInt(s.bit_rate, 10) / 1000) : 0,
                    channels: s.channels ?? 2,
                    sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : 44100,
                    language: s.tags?.language,
                    title: s.tags?.title,
                });
            }
        }

        const format = {
            duration: data.format.duration ? parseFloat(data.format.duration) : 0,
            bitrateKbps: data.format.bit_rate ? Math.round(parseInt(data.format.bit_rate, 10) / 1000) : 0,
            formatName: data.format.format_name ?? 'unknown',
        };

        this.logger.log(
            `Probed: ${videoTracks.length} video track(s), ${audioTracks.length} audio track(s), ` +
            `duration=${format.duration.toFixed(1)}s`,
        );

        return { format, videoTracks, audioTracks };
    }

    suggest(probe: ProbeResult): SuggestedConfig {
        const hasVideo = probe.videoTracks.length > 0;
        const hasMultipleVideoTracks = probe.videoTracks.length > 1;

        if (!hasVideo) {
            return this.suggestAudioOnly(probe);
        }

        if (hasMultipleVideoTracks) {
            return this.suggestMultiVideoTrack(probe);
        }

        return this.suggestSingleVideoTrack(probe);
    }

    private suggestAudioOnly(probe: ProbeResult): SuggestedConfig {
        const audioRenditions: SuggestedAudioRendition[] = [];

        const sourceTrack = probe.audioTracks[0];
        const sourceBitrate = sourceTrack?.bitrateKbps || 256;

        const tiers = [256, 128, 64].filter(b => b <= sourceBitrate + 32);
        if (tiers.length === 0) tiers.push(sourceBitrate || 128);

        for (const bitrate of tiers) {
            const channels = bitrate <= 64 ? 1 : 2;
            audioRenditions.push({
                audioBitrateKbps: bitrate,
                channels,
                audioCodec: 'aac',
                sourceTrackIndex: sourceTrack?.index ?? 0,
                language: sourceTrack?.language,
                label: `${bitrate}kbps`,
            });
        }

        return {
            type: 'audio',
            segmentDuration: 6,
            audioRenditions,
        };
    }

    private suggestMultiVideoTrack(probe: ProbeResult): SuggestedConfig {
        const videoRenditions: SuggestedVideoRendition[] = [];
        const audioGroupSet = new Map<string, SuggestedAudioGroup>();

        const sortedTracks = [...probe.videoTracks].sort(
            (a, b) => (b.height * b.width) - (a.height * a.width),
        );

        for (const track of sortedTracks) {
            const tier = this.getAudioTierForHeight(track.height);
            videoRenditions.push({
                width: track.width,
                height: track.height,
                videoBitrateKbps: track.bitrateKbps || this.estimateBitrateForHeight(track.height),
                copyStream: true,
                sourceTrackIndex: track.index,
                audioGroupId: tier.groupId,
                label: track.title ?? `${track.height}p`,
            });

            if (!audioGroupSet.has(tier.groupId)) {
                const sourceAudio = probe.audioTracks[0];
                audioGroupSet.set(tier.groupId, {
                    id: tier.groupId,
                    label: tier.label,
                    audioBitrateKbps: tier.bitrateKbps,
                    channels: tier.channels,
                    audioCodec: 'aac',
                    sourceTrackIndex: sourceAudio?.index ?? 0,
                    language: sourceAudio?.language,
                });
            }
        }

        return {
            type: 'video',
            segmentDuration: 6,
            videoRenditions,
            audioGroups: Array.from(audioGroupSet.values()),
        };
    }

    private suggestSingleVideoTrack(probe: ProbeResult): SuggestedConfig {
        const source = probe.videoTracks[0];
        const sourceHeight = source.height;
        const sourceWidth = source.width;

        const ladder = ABR_LADDER.filter(r => r.height <= sourceHeight);
        if (ladder.length === 0) {
            ladder.push({
                height: sourceHeight,
                width: sourceWidth,
                bitrateKbps: source.bitrateKbps || 1000,
                label: `${sourceHeight}p`,
            });
        }

        const audioGroupSet = new Map<string, SuggestedAudioGroup>();
        const videoRenditions: SuggestedVideoRendition[] = [];

        for (const rung of ladder) {
            const tier = this.getAudioTierForHeight(rung.height);

            videoRenditions.push({
                width: rung.width,
                height: rung.height,
                videoBitrateKbps: rung.bitrateKbps,
                copyStream: false,
                audioGroupId: tier.groupId,
                label: rung.label,
            });

            if (!audioGroupSet.has(tier.groupId)) {
                const sourceAudio = probe.audioTracks[0];
                audioGroupSet.set(tier.groupId, {
                    id: tier.groupId,
                    label: tier.label,
                    audioBitrateKbps: tier.bitrateKbps,
                    channels: tier.channels,
                    audioCodec: 'aac',
                    sourceTrackIndex: sourceAudio?.index ?? 0,
                    language: sourceAudio?.language,
                });
            }
        }

        return {
            type: 'video',
            segmentDuration: 6,
            videoRenditions,
            audioGroups: Array.from(audioGroupSet.values()),
        };
    }

    private getAudioTierForHeight(height: number): (typeof AUDIO_GROUP_TIERS)[number] {
        for (const tier of AUDIO_GROUP_TIERS) {
            if (height >= tier.minHeight) return tier;
        }
        return AUDIO_GROUP_TIERS[AUDIO_GROUP_TIERS.length - 1];
    }

    private estimateBitrateForHeight(height: number): number {
        for (const rung of ABR_LADDER) {
            if (height >= rung.height) return rung.bitrateKbps;
        }
        return 300;
    }

    private parseFrameRate(rate: string): number {
        const parts = rate.split('/');
        if (parts.length === 2) {
            const num = parseInt(parts[0], 10);
            const den = parseInt(parts[1], 10);
            if (den > 0) return Math.round((num / den) * 100) / 100;
        }
        const parsed = parseFloat(rate);
        return isNaN(parsed) ? 0 : parsed;
    }
}
