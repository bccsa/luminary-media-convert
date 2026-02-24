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
    name?: string;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    bitrateKbps: number;
    channels: number;
    sampleRate: number;
    language?: string;
    name?: string;
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

@Injectable()
export class ProbeService {
    private readonly logger = new Logger(ProbeService.name);

    probe(filePath: string): ProbeResult {
        const data = this.runFfprobe(filePath);

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
                    bitrateKbps: this.extractBitrateKbps(s),
                    frameRate: this.parseFrameRate(s.avg_frame_rate ?? s.r_frame_rate ?? '0/1'),
                    profile: s.profile,
                    language: s.tags?.language,
                    name: s.tags?.title,
                });
            } else if (s.codec_type === 'audio') {
                audioTracks.push({
                    index: audioStreamIndex++,
                    codec: s.codec_name ?? 'unknown',
                    bitrateKbps: this.extractBitrateKbps(s),
                    channels: s.channels ?? 2,
                    sampleRate: s.sample_rate ? parseInt(s.sample_rate, 10) : 44100,
                    language: s.tags?.language,
                    name: s.tags?.title,
                });
            }
        }

        const formatBitrateKbps = data.format.bit_rate
            ? Math.round(parseInt(data.format.bit_rate, 10) / 1000)
            : 0;

        const hasMissingBitrates = [...videoTracks, ...audioTracks].some(t => t.bitrateKbps === 0);
        if (hasMissingBitrates) {
            const duration = data.format.duration ? parseFloat(data.format.duration) : 0;
            this.computeBitratesFromPackets(filePath, data.streams, videoTracks, audioTracks, duration);
        }

        const format = {
            duration: data.format.duration ? parseFloat(data.format.duration) : 0,
            bitrateKbps: formatBitrateKbps,
            formatName: data.format.format_name ?? 'unknown',
        };

        this.logger.log(
            `Probed: ${videoTracks.length} video track(s), ${audioTracks.length} audio track(s), ` +
            `duration=${format.duration.toFixed(1)}s`,
        );

        return { format, videoTracks, audioTracks };
    }

    private runFfprobe(filePath: string): FfprobeOutput {
        const raw = execSync(
            `ffprobe -v quiet -print_format json -show_format -show_streams "${filePath}"`,
            { encoding: 'utf-8', timeout: 60000 },
        );
        return JSON.parse(raw);
    }

    private extractBitrateKbps(stream: FfprobeStream): number {
        if (stream.bit_rate) {
            return Math.round(parseInt(stream.bit_rate, 10) / 1000);
        }
        if (stream.tags?.BPS) {
            return Math.round(parseInt(stream.tags.BPS, 10) / 1000);
        }
        if (stream.tags?.NUMBER_OF_BYTES && stream.tags?.DURATION) {
            const bytes = parseInt(stream.tags.NUMBER_OF_BYTES, 10);
            const duration = this.parseDurationTag(stream.tags.DURATION);
            if (duration > 0) {
                return Math.round((bytes * 8) / duration / 1000);
            }
        }
        return 0;
    }

    /**
     * When stream-level bitrates are unavailable (common in Matroska),
     * compute actual bitrates by summing packet sizes per stream via ffprobe.
     */
    private computeBitratesFromPackets(
        filePath: string,
        rawStreams: FfprobeStream[],
        videoTracks: VideoTrackInfo[],
        audioTracks: AudioTrackInfo[],
        duration: number,
    ): void {
        if (duration <= 0) return;

        this.logger.log('Stream-level bitrates missing, computing from packet data...');

        try {
            const csv = execSync(
                `ffprobe -v quiet -print_format csv=p=0 -show_entries packet=stream_index,size "${filePath}"`,
                { encoding: 'utf-8', timeout: 120000, maxBuffer: 200 * 1024 * 1024 },
            );

            const bytesPerStream = new Map<number, number>();
            for (const line of csv.split('\n')) {
                if (!line) continue;
                const parts = line.split(',');
                if (parts.length < 2) continue;
                const streamIndex = parseInt(parts[0], 10);
                const size = parseInt(parts[1], 10);
                if (isNaN(streamIndex) || isNaN(size)) continue;
                bytesPerStream.set(streamIndex, (bytesPerStream.get(streamIndex) ?? 0) + size);
            }

            const avStreamToType = new Map<number, { type: 'video' | 'audio'; localIndex: number }>();
            let vi = 0;
            let ai = 0;
            for (const s of rawStreams) {
                if (s.codec_type === 'video') {
                    avStreamToType.set(s.index, { type: 'video', localIndex: vi++ });
                } else if (s.codec_type === 'audio') {
                    avStreamToType.set(s.index, { type: 'audio', localIndex: ai++ });
                }
            }

            for (const [streamIndex, totalBytes] of bytesPerStream) {
                const mapping = avStreamToType.get(streamIndex);
                if (!mapping) continue;
                const bitrateKbps = Math.round((totalBytes * 8) / duration / 1000);
                if (mapping.type === 'video') {
                    const track = videoTracks[mapping.localIndex];
                    if (track && track.bitrateKbps === 0) {
                        track.bitrateKbps = bitrateKbps;
                    }
                } else {
                    const track = audioTracks[mapping.localIndex];
                    if (track && track.bitrateKbps === 0) {
                        track.bitrateKbps = bitrateKbps;
                    }
                }
            }

            this.logger.log('Packet-based bitrate computation complete');
        } catch (err) {
            this.logger.warn(
                `Packet-based bitrate computation failed: ${(err as Error).message}`,
            );
        }
    }

    private parseDurationTag(duration: string): number {
        const match = duration.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
        if (!match) return 0;
        return parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
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
