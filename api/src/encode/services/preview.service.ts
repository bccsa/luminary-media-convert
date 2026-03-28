import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { createReadStream, existsSync } from 'fs';
import { mkdir, rm, readFile, writeFile } from 'fs/promises';
import type { ReadStream } from 'fs';
import { SessionService } from './session.service.js';
import type { ProbeResult } from './probe.service.js';

const execFileAsync = promisify(execFile);

// Codecs that can be remuxed to MPEG-TS for browser MSE playback
const TS_COPY_CODECS = new Set(['h264', 'vp8', 'vp9']);

const SEGMENT_DURATION = 4;

interface SegmentBoundary {
    start: number;
    duration: number;
}

interface PreviewState {
    filePath: string;
    duration: number;
    segmentBoundaries: SegmentBoundary[];
    videoStreamIndex: number;
    audioStreamIndex: number;
    canCopyVideo: boolean;
    previewDir: string;
    playlist: string;
}

@Injectable()
export class PreviewService {
    private readonly logger = new Logger(PreviewService.name);
    private readonly states = new Map<string, PreviewState>();
    // Mutex for FFmpeg — one extraction at a time per session
    private readonly pending = new Map<string, Promise<string>>();

    constructor(private readonly sessionService: SessionService) {}

    /** Initialize preview for a session after probe completes */
    async init(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session?.filePath || !session.probeResult) {
            this.logger.warn(`Cannot init preview for ${sessionId}: no file or probe`);
            return;
        }

        const { filePath, probeResult } = session;
        const previewDir = join(filePath, '..', 'preview');
        await mkdir(previewDir, { recursive: true });

        // Select best video and audio streams for preview
        const { videoIndex, audioIndex, canCopy } =
            this.selectStreams(probeResult);

        const duration = probeResult.format.duration;

        // For copy mode: scan keyframes for aligned segment boundaries.
        // For transcode mode: use fixed intervals (can cut at any position).
        const boundaries = canCopy
            ? await this.scanKeyframes(filePath, videoIndex)
            : [];

        const playlist = this.generatePlaylist(boundaries, duration);

        this.states.set(sessionId, {
            filePath,
            duration,
            segmentBoundaries: boundaries,
            videoStreamIndex: videoIndex,
            audioStreamIndex: audioIndex,
            canCopyVideo: canCopy,
            previewDir,
            playlist,
        });

        this.logger.log(
            `Preview initialized for ${sessionId}: ${boundaries.length} segments, ` +
                `video=#${videoIndex} (${canCopy ? 'copy' : 'transcode'}), ` +
                `audio=#${audioIndex}`,
        );
    }

    /** Returns true if preview is initialized for this session */
    isReady(sessionId: string): boolean {
        return this.states.has(sessionId);
    }

    /** Get the HLS playlist for the session, with token embedded in segment URLs */
    getPlaylist(sessionId: string, token: string): string | null {
        const state = this.states.get(sessionId);
        if (!state) return null;
        // Append token to segment URLs so VHS can fetch them authenticated
        return state.playlist.replace(
            /segment(\d+)\.ts/g,
            `segment$1.ts?token=${token}`,
        );
    }

    /** Get a segment file stream, extracting on demand if not cached */
    async getSegmentStream(
        sessionId: string,
        segmentIndex: number,
    ): Promise<{ stream: ReadStream; size: number } | null> {
        const state = this.states.get(sessionId);
        if (!state) return null;

        const totalSegments = state.segmentBoundaries.length > 0
            ? state.segmentBoundaries.length
            : Math.ceil(state.duration / SEGMENT_DURATION);
        if (segmentIndex < 0 || segmentIndex >= totalSegments)
            return null;

        const segPath = join(state.previewDir, `segment${segmentIndex}.ts`);

        // Return cached segment
        if (existsSync(segPath)) {
            const stream = createReadStream(segPath);
            const stat = await import('fs/promises').then((m) =>
                m.stat(segPath),
            );
            return { stream, size: stat.size };
        }

        // Extract on demand (deduplicate concurrent requests)
        const cacheKey = `${sessionId}:${segmentIndex}`;
        let promise = this.pending.get(cacheKey);
        if (!promise) {
            promise = this.extractSegment(state, segmentIndex, segPath);
            this.pending.set(cacheKey, promise);
            promise.finally(() => this.pending.delete(cacheKey));
        }

        await promise;

        if (existsSync(segPath)) {
            const stream = createReadStream(segPath);
            const stat = await import('fs/promises').then((m) =>
                m.stat(segPath),
            );
            return { stream, size: stat.size };
        }

        return null;
    }

    /** Clean up preview state and cached files */
    async destroy(sessionId: string): Promise<void> {
        const state = this.states.get(sessionId);
        if (!state) return;
        this.states.delete(sessionId);
        await rm(state.previewDir, { recursive: true, force: true }).catch(
            () => {},
        );
    }

    // -----------------------------------------------------------------------
    // Private
    // -----------------------------------------------------------------------

    private selectStreams(probe: ProbeResult): {
        videoIndex: number;
        audioIndex: number;
        canCopy: boolean;
    } {
        // Pick a video stream — prefer lowest resolution ≥ 480p for preview
        const videos = [...probe.videoTracks].sort(
            (a, b) => a.width * a.height - b.width * b.height,
        );
        const selected =
            videos.find((v) => v.height >= 480) ??
            videos[videos.length - 1] ??
            videos[0];

        const videoIndex = selected?.index ?? 0;
        const canCopy =
            !!selected && TS_COPY_CODECS.has(selected.codec.toLowerCase());

        const audioIndex = probe.audioTracks[0]?.index ?? -1;

        return { videoIndex, audioIndex, canCopy };
    }

    private async scanKeyframes(
        filePath: string,
        videoStreamIndex: number,
    ): Promise<SegmentBoundary[]> {
        // Use ffmpeg segment muxer to find keyframe-aligned boundaries.
        // Fast — copy mode, video only, discards output after parsing CSV.
        const tmpDir = join(filePath, '..', 'kfscan');
        await mkdir(tmpDir, { recursive: true });

        const csvPath = join(tmpDir, 'segments.csv');

        try {
            await execFileAsync('ffmpeg', [
                '-i', filePath,
                '-map', `0:v:${videoStreamIndex}`,
                '-c:v', 'copy',
                '-an',
                '-f', 'segment',
                '-segment_time', String(SEGMENT_DURATION),
                '-segment_list', csvPath,
                '-segment_list_type', 'csv',
                '-y',
                join(tmpDir, 'seg%d.ts'),
            ], { timeout: 120_000 });

            const csv = await readFile(csvPath, 'utf8');
            return csv
                .trim()
                .split('\n')
                .filter((line) => line.length > 0)
                .map((line) => {
                    const parts = line.split(',');
                    const start = parseFloat(parts[1]);
                    const end = parseFloat(parts[2]);
                    return { start, duration: end - start };
                });
        } catch (e) {
            this.logger.warn(`Keyframe scan failed for ${filePath}: ${e}`);
            return [];
        } finally {
            await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        }
    }

    private generatePlaylist(
        boundaries: SegmentBoundary[],
        duration: number,
    ): string {
        const segCount =
            boundaries.length > 0
                ? boundaries.length
                : Math.ceil(duration / SEGMENT_DURATION);

        let maxDuration = SEGMENT_DURATION;
        if (boundaries.length > 0) {
            maxDuration = Math.ceil(
                Math.max(...boundaries.map((b) => b.duration)),
            );
        }

        const lines: string[] = [
            '#EXTM3U',
            '#EXT-X-VERSION:3',
            `#EXT-X-TARGETDURATION:${maxDuration}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:VOD',
        ];

        // Each segment is independently extracted — mark discontinuities
        // so VHS handles codec parameter changes between segments
        // (different SPS/PPS for transcoded, different PTS for copy-mode)
        for (let i = 0; i < segCount; i++) {
            if (i > 0) {
                lines.push('#EXT-X-DISCONTINUITY');
            }
            const segDur =
                boundaries.length > 0
                    ? boundaries[i].duration
                    : Math.min(
                          SEGMENT_DURATION,
                          duration - i * SEGMENT_DURATION,
                      );
            lines.push(`#EXTINF:${segDur.toFixed(3)},`);
            lines.push(`segment${i}.ts`);
        }

        lines.push('#EXT-X-ENDLIST');
        lines.push('');

        return lines.join('\n');
    }

    private async extractSegment(
        state: PreviewState,
        index: number,
        outputPath: string,
    ): Promise<string> {
        const boundary = state.segmentBoundaries[index];
        const start = boundary?.start ?? index * SEGMENT_DURATION;
        const segDur =
            boundary?.duration ??
            Math.min(SEGMENT_DURATION, state.duration - start);

        const args: string[] = [];

        // ProbeResult uses type-relative indices (0th video, 0th audio).
        // Use -map 0:v:N and -map 0:a:N for correct stream selection.
        const videoMap = `0:v:${state.videoStreamIndex}`;
        const audioMap = state.audioStreamIndex >= 0 ? `0:a:${state.audioStreamIndex}` : null;

        // Always use -ss before -i (input seeking) for fast seeking.
        // FFmpeg seeks to the nearest keyframe, decodes from there,
        // then outputs from the exact requested position.
        args.push(
            '-ss', String(start),
            '-t', String(segDur),
            '-i', state.filePath,
            '-map', videoMap,
        );
        if (audioMap) args.push('-map', audioMap);

        if (state.canCopyVideo) {
            args.push('-c:v', 'copy');
        } else {
            args.push(
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '28',
                '-tune', 'zerolatency',
                '-vf', 'scale=480:-2',
            );
        }

        if (audioMap) {
            args.push('-c:a', 'aac', '-b:a', '128k');
        }

        args.push('-f', 'mpegts', '-y', outputPath);

        this.logger.debug(`Segment ${index}: ffmpeg ${args.join(' ')}`);

        try {
            const timeout = state.canCopyVideo ? 30_000 : 120_000;
            const { stderr } = await execFileAsync('ffmpeg', args, {
                timeout,
                maxBuffer: 10 * 1024 * 1024,
            });
            if (stderr) {
                // Log last few lines of FFmpeg stderr for debugging
                const lines = stderr.trim().split('\n');
                const tail = lines.slice(-3).join(' | ');
                this.logger.debug(`Segment ${index} done: ${tail}`);
            }
        } catch (e: any) {
            this.logger.error(
                `Segment ${index} extraction failed: ${e.message}`,
            );
            if (e.stderr) {
                const lines = e.stderr.trim().split('\n');
                this.logger.error(`FFmpeg stderr: ${lines.slice(-5).join('\n')}`);
            }
            throw e;
        }

        return outputPath;
    }
}
