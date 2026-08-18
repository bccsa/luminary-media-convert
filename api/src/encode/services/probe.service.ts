import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ffprobeBin } from './ffbin.js';

const execFileAsync = promisify(execFile);

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
    /**
     * Where this stream's first frame sits on the container timeline, seconds.
     *
     * Streams in the same file routinely do not start together, and the encode
     * seeks past the head to make them. That decides whether a copy-mode
     * rendition is safe, so the number has to reach the caller rather than
     * staying inside the encoder.
     */
    startTime?: number;
    /** Frames between consecutive keyframes, as sampled from the head. */
    gopFrames?: number;
    /** {@link gopFrames} in seconds, for saying out loud. */
    gopSeconds?: number;
    /**
     * Every sampled keyframe interval was the same length. False means the
     * source cuts keyframes where it likes, which no segment duration can be
     * made to divide into.
     */
    gopRegular?: boolean;
    /**
     * Frames the decoder must hold to reorder this stream — ffprobe's
     * `has_b_frames`, which is a reorder depth rather than a flag.
     */
    hasBFrames?: number;
    /** Chroma format and bit depth, e.g. `yuv420p`. */
    pixFmt?: string;
    /**
     * Codec level, in the codec's own numbering (H.264 4.0 reports 40).
     * Negative or absent when the container does not say.
     */
    level?: number;
}

export interface AudioTrackInfo {
    index: number;
    codec: string;
    bitrateKbps: number;
    channels: number;
    sampleRate: number;
    language?: string;
    name?: string;
    /** See {@link VideoTrackInfo.startTime}. */
    startTime?: number;
}

/** What {@link ProbeService.probeGopInfo} could work out about a track's GOP. */
export interface GopInfo {
    gopFrames: number;
    gopSeconds: number;
    regular: boolean;
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
    start_time?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    profile?: string;
    has_b_frames?: number;
    pix_fmt?: string;
    level?: number;
    channels?: number;
    sample_rate?: string;
    tags?: Record<string, string>;
    disposition?: { attached_pic?: number };
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

/**
 * A stream's language, or nothing when it does not have one.
 *
 * FFprobe reports the literal `und` for an untagged stream — ISO 639-2 for
 * "undetermined" — and a placeholder that is not blank is worse than a blank
 * one, because every reader has to know it. Three places downstream already
 * did: `audioGroups.ts` normalises it away before building a config, and
 * `SessionView` filters it out of a label. The one that forgot was the guard in
 * `applySavedTrackLabels`, which fills only fields it finds empty — `und` is
 * truthy, so a saved language was never restored to a source that had none,
 * while saved track names came back correctly and made the omission look
 * arbitrary.
 *
 * Normalising here rather than at each reader means a language is present or it
 * is absent, and nothing has to remember a third case. Empty and whitespace-only
 * tags go the same way; casing is not guaranteed by ffprobe, so the comparison
 * does not rely on it.
 *
 * Note this reaches the wire: `probeResult` travels on the status response and
 * over SSE, so a consumer sees the field missing rather than carrying `und`.
 */
function normalizeLanguage(tag?: string): string | undefined {
    const trimmed = tag?.trim();
    if (!trimmed || trimmed.toLowerCase() === 'und') return undefined;
    return trimmed;
}

/**
 * A stream's start time in seconds, with `N/A` and an absent tag both reading
 * as the top of the timeline.
 *
 * Zero rather than undefined, deliberately: everything that reads this compares
 * one stream's start against another's, and a missing third case would have to
 * be answered somewhere. A container that does not say where a stream starts is
 * saying it starts where the file does.
 */
function parseStartTime(raw?: string): number {
    const parsed = parseFloat(raw ?? '');
    return Number.isFinite(parsed) ? parsed : 0;
}

@Injectable()
export class ProbeService {
    private readonly logger = new Logger(ProbeService.name);

    async probe(filePath: string): Promise<ProbeResult> {
        const data = await this.runFfprobe(filePath);

        const videoTracks: VideoTrackInfo[] = [];
        const audioTracks: AudioTrackInfo[] = [];

        let videoStreamIndex = 0;
        let audioStreamIndex = 0;

        for (const s of data.streams) {
            if (s.codec_type === 'video') {
                if (s.disposition?.attached_pic === 1) continue;
                videoTracks.push({
                    index: videoStreamIndex++,
                    codec: s.codec_name ?? 'unknown',
                    width: s.width ?? 0,
                    height: s.height ?? 0,
                    bitrateKbps: this.extractBitrateKbps(s),
                    frameRate: this.parseFrameRate(
                        s.avg_frame_rate ?? s.r_frame_rate ?? '0/1'
                    ),
                    profile: s.profile,
                    language: normalizeLanguage(s.tags?.language),
                    name: s.tags?.title,
                    startTime: parseStartTime(s.start_time),
                    hasBFrames: s.has_b_frames,
                    pixFmt: s.pix_fmt,
                    level: s.level,
                });
            } else if (s.codec_type === 'audio') {
                audioTracks.push({
                    index: audioStreamIndex++,
                    codec: s.codec_name ?? 'unknown',
                    bitrateKbps: this.extractBitrateKbps(s),
                    channels: s.channels ?? 2,
                    sampleRate: s.sample_rate
                        ? parseInt(s.sample_rate, 10)
                        : 44100,
                    language: normalizeLanguage(s.tags?.language),
                    name: s.tags?.title,
                    startTime: parseStartTime(s.start_time),
                });
            }
        }

        const formatBitrateKbps = data.format.bit_rate
            ? Math.round(parseInt(data.format.bit_rate, 10) / 1000)
            : 0;

        const hasMissingBitrates = [...videoTracks, ...audioTracks].some(
            (t) => t.bitrateKbps === 0
        );
        if (hasMissingBitrates) {
            const duration = data.format.duration
                ? parseFloat(data.format.duration)
                : 0;
            await this.computeBitratesFromPackets(
                filePath,
                data.streams,
                videoTracks,
                audioTracks,
                duration
            );
        }

        // Keyframe cadence, per video track. It answers one question — may this
        // track be copied rather than re-encoded — and the form asks it before
        // the encode is submitted, so it is settled here alongside everything
        // else the caller decides from. One extra ffprobe per video track, each
        // reading two hundred frames off the head; sources have few.
        await Promise.all(
            videoTracks.map(async (track) => {
                const gop = await this.probeGopInfo(
                    filePath,
                    track.index,
                    track.frameRate
                );
                if (!gop) return;
                track.gopFrames = gop.gopFrames;
                track.gopSeconds = gop.gopSeconds;
                track.gopRegular = gop.regular;
            })
        );

        const format = {
            duration: data.format.duration
                ? parseFloat(data.format.duration)
                : 0,
            bitrateKbps: formatBitrateKbps,
            formatName: data.format.format_name ?? 'unknown',
        };

        this.logger.log(
            `Probed: ${videoTracks.length} video track(s), ${audioTracks.length} audio track(s), ` +
                `duration=${format.duration.toFixed(1)}s`
        );

        return { format, videoTracks, audioTracks };
    }

    /**
     * A video track's keyframe cadence, or null when it cannot be established.
     *
     * Measures *every* interval in the sampled window rather than the first
     * two. A source that opens with a keyframe pair and then cuts them wherever
     * the picture changes would otherwise report a tidy GOP it does not keep,
     * and copy mode would be allowed on the strength of it — which is precisely
     * the case that produces segments of the wrong length.
     *
     * Two hundred frames is a window, not the file: at 30 fps and a two-second
     * GOP that is three or four intervals, enough to catch an irregular source
     * without decoding minutes of video at ingest. The frames trailing the last
     * keyframe are a partial GOP and are not an interval, so they are ignored.
     */
    async probeGopInfo(
        filePath: string,
        videoTrackIndex: number,
        frameRate: number
    ): Promise<GopInfo | null> {
        if (!(frameRate > 0)) return null;
        try {
            const { stdout } = await execFileAsync(
                ffprobeBin(),
                [
                    '-v',
                    'error',
                    '-select_streams',
                    `v:${videoTrackIndex}`,
                    '-show_frames',
                    '-show_entries',
                    'frame=pict_type',
                    '-of',
                    'csv=p=0',
                    '-read_intervals',
                    '%+#200',
                    filePath,
                ],
                { timeout: 60000 }
            );

            // The pict_type is the first CSV field, not the whole line:
            // ffprobe appends any side data to the same row, so a keyframe
            // carrying an SEI message arrives as
            // "I,H.26[45] User Data Unregistered SEI message". Comparing the
            // whole line missed those, which read as "one keyframe in the
            // window" and refused copy mode on perfectly ordinary sources.
            const keyframeIndices: number[] = [];
            const frames = stdout.split('\n');
            for (let i = 0; i < frames.length; i++) {
                if (frames[i].split(',')[0].trim() === 'I')
                    keyframeIndices.push(i);
            }
            if (keyframeIndices.length < 2) return null;

            const intervals: number[] = [];
            for (let i = 1; i < keyframeIndices.length; i++) {
                intervals.push(keyframeIndices[i] - keyframeIndices[i - 1]);
            }

            const gopFrames = intervals[0];
            if (gopFrames <= 0) return null;
            return {
                gopFrames,
                gopSeconds: Math.round((gopFrames / frameRate) * 1000) / 1000,
                regular: intervals.every((n) => n === gopFrames),
            };
        } catch {
            this.logger.warn(
                `Could not probe keyframe cadence for video track ${videoTrackIndex}`
            );
            return null;
        }
    }

    private async runFfprobe(filePath: string): Promise<FfprobeOutput> {
        const { stdout } = await execFileAsync(
            ffprobeBin(),
            [
                '-v',
                'quiet',
                '-print_format',
                'json',
                '-show_format',
                '-show_streams',
                filePath,
            ],
            { timeout: 60000 }
        );
        return JSON.parse(stdout);
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
    private async computeBitratesFromPackets(
        filePath: string,
        rawStreams: FfprobeStream[],
        videoTracks: VideoTrackInfo[],
        audioTracks: AudioTrackInfo[],
        duration: number
    ): Promise<void> {
        if (duration <= 0) return;

        this.logger.log(
            'Stream-level bitrates missing, computing from packet data...'
        );

        try {
            // Scanning a multi-GB file to price it is not worth the wait, so
            // this samples. But sampling only the opening prices the programme
            // by its introduction: a broadcast that starts quietly reported
            // four of five audio tracks at 2 kbps, and every suggestion built
            // on those numbers inherited the mistake. Sample at several points
            // instead and keep the loudest, which is the one that describes
            // what the stream actually needs.
            const sampleDuration = Math.min(10, duration);
            const starts = this.packetSampleStarts(duration, sampleDuration);
            const { stdout: csv } = await execFileAsync(
                ffprobeBin(),
                [
                    '-v',
                    'quiet',
                    '-print_format',
                    'csv=p=0',
                    '-read_intervals',
                    this.readIntervalsArg(starts, sampleDuration),
                    '-show_entries',
                    'packet=stream_index,size,pts_time',
                    filePath,
                ],
                { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
            );

            // Kept per sample so a quiet stretch cannot drag down a loud one.
            // Each packet carries the timestamp that places it in its sample.
            const bytesPerSample = new Map<number, number[]>();
            for (const line of csv.split('\n')) {
                if (!line) continue;
                const parts = line.split(',');
                if (parts.length < 2) continue;
                const streamIndex = parseInt(parts[0], 10);
                const size = parseInt(parts[1], 10);
                if (isNaN(streamIndex) || isNaN(size)) continue;
                if (!bytesPerSample.has(streamIndex)) {
                    bytesPerSample.set(
                        streamIndex,
                        new Array(starts.length).fill(0)
                    );
                }
                const sample = this.sampleIndexFor(
                    parseFloat(parts[2]),
                    starts
                );
                bytesPerSample.get(streamIndex)![sample] += size;
            }

            const bytesPerStream = new Map<number, number>();
            for (const [streamIndex, samples] of bytesPerSample) {
                bytesPerStream.set(streamIndex, Math.max(...samples));
            }

            const avStreamToType = new Map<
                number,
                { type: 'video' | 'audio'; localIndex: number }
            >();
            let vi = 0;
            let ai = 0;
            for (const s of rawStreams) {
                if (s.codec_type === 'video') {
                    if (s.disposition?.attached_pic === 1) continue;
                    avStreamToType.set(s.index, {
                        type: 'video',
                        localIndex: vi++,
                    });
                } else if (s.codec_type === 'audio') {
                    avStreamToType.set(s.index, {
                        type: 'audio',
                        localIndex: ai++,
                    });
                }
            }

            for (const [streamIndex, totalBytes] of bytesPerStream) {
                const mapping = avStreamToType.get(streamIndex);
                if (!mapping) continue;
                const bitrateKbps = Math.round(
                    (totalBytes * 8) / sampleDuration / 1000
                );
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

            this.logger.log(
                `Packet-based bitrate computation complete ` +
                    `(${starts.length} sample(s) of ${sampleDuration.toFixed(1)}s)`
            );
        } catch (err) {
            this.logger.warn(
                `Packet-based bitrate computation failed: ${(err as Error).message}`
            );
        }
    }

    /**
     * Offsets to sample from, in seconds — spread through the file so a quiet
     * opening cannot speak for the whole of it. A file barely longer than one
     * sample has nowhere else to look and keeps the original head-only read.
     */
    private packetSampleStarts(
        duration: number,
        sampleDuration: number
    ): number[] {
        if (duration <= sampleDuration * 2) return [0];
        const latestStart = duration - sampleDuration;
        const starts = [0.1, 0.5, 0.9].map(
            (fraction) =>
                Math.round(
                    Math.max(0, Math.min(latestStart, duration * fraction)) *
                        1000
                ) / 1000
        );
        // Clamping to the last usable start can collide on shorter files.
        // Overlapping samples are harmless; duplicate reads are just waste.
        return [...new Set(starts)];
    }

    /** ffprobe `-read_intervals`: `START%+DURATION`, comma separated. */
    private readIntervalsArg(starts: number[], sampleDuration: number): string {
        // A lone sample from the top keeps the original spelling, so short
        // files issue exactly the request they always did.
        if (starts.length === 1 && starts[0] === 0)
            return `%+${sampleDuration}`;
        return starts.map((s) => `${s}%+${sampleDuration}`).join(',');
    }

    /**
     * Which sample a packet belongs to: the last one starting at or before its
     * timestamp. Packets without a usable timestamp fall to the first sample
     * rather than being discarded.
     */
    private sampleIndexFor(pts: number, starts: number[]): number {
        if (!Number.isFinite(pts)) return 0;
        let index = 0;
        for (let i = 0; i < starts.length; i++) {
            if (pts >= starts[i]) index = i;
        }
        return index;
    }

    private parseDurationTag(duration: string): number {
        const match = duration.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
        if (!match) return 0;
        return (
            parseInt(match[1], 10) * 3600 +
            parseInt(match[2], 10) * 60 +
            parseFloat(match[3])
        );
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
