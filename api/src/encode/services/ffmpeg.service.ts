import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { spawn, execFile, execSync, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { Worker } from 'worker_threads';
import type {
    EncodeConfigDto,
    VideoRenditionDto,
    AudioGroupDto,
    TrimSegmentDto,
} from '../dto/encode-config.dto.js';
import dotenv from 'dotenv';
import { ffmpegBin, ffmpegShellBin, ffprobeBin } from './ffbin.js';

const execFileAsync = promisify(execFile);

dotenv.config();

export interface EncodeOptions {
    sessionId: string;
    inputPath: string;
    outputDir: string;
    encodeConfig: EncodeConfigDto;
    onProgress: (percent: number) => void;
    byteRange?: boolean;
    byteRangeMaxFileSizeBytes?: number;
    preByteRangeHook?: (outputDir: string) => void | Promise<void>;
}

export type SegmentFormat = 'fmp4' | 'mpegts';

export interface EncodeResult {
    outputDir: string;
    masterPlaylist: string;
    segmentFormat: SegmentFormat;
}

export type AccelMode = 'cpu' | 'nvidia' | 'apple';

@Injectable()
export class FfmpegService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FfmpegService.name);
    private accelMode: AccelMode = 'cpu';
    private activeProcess: ChildProcess | null = null;
    private readonly timeoutMs = process.env.FFMPEG_TIMEOUT_MS
        ? parseInt(process.env.FFMPEG_TIMEOUT_MS, 10)
        : 0;
    private readonly threads = process.env.FFMPEG_THREADS
        ? parseInt(process.env.FFMPEG_THREADS, 10)
        : 8;

    async onModuleInit(): Promise<void> {
        this.accelMode = this.detectAcceleration();
        switch (this.accelMode) {
            case 'nvidia':
                this.logger.log(
                    'NVIDIA GPU detected, using NVENC acceleration'
                );
                break;
            case 'apple':
                this.logger.log(
                    'Apple Silicon detected, using VideoToolbox acceleration'
                );
                break;
            default:
                this.logger.log('No GPU found, using CPU encoding');
        }
        this.logger.log(`FFmpeg threads: ${this.threads}`);
    }

    async onModuleDestroy(): Promise<void> {
        if (this.activeProcess && !this.activeProcess.killed) {
            this.logger.log('Shutting down: killing active FFmpeg process...');
            this.activeProcess.kill('SIGTERM');

            await new Promise<void>((resolve) => {
                const forceKillTimer = setTimeout(() => {
                    if (this.activeProcess && !this.activeProcess.killed) {
                        this.activeProcess.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);

                this.activeProcess?.once('close', () => {
                    clearTimeout(forceKillTimer);
                    resolve();
                });
            });

            this.activeProcess = null;
        }
    }

    private detectAcceleration(): AccelMode {
        if (this.detectNvidiaGpu()) return 'nvidia';
        if (this.detectAppleGpu()) return 'apple';
        return 'cpu';
    }

    private detectNvidiaGpu(): boolean {
        try {
            execSync('nvidia-smi', { stdio: 'ignore', timeout: 5000 });
        } catch {
            return false;
        }

        try {
            const hwaccels = execSync(
                `${ffmpegShellBin()} -hwaccels 2>/dev/null`,
                {
                    encoding: 'utf-8',
                    timeout: 5000,
                }
            );
            return hwaccels.includes('cuda');
        } catch {
            return false;
        }
    }

    private detectAppleGpu(): boolean {
        if (process.platform !== 'darwin' || process.arch !== 'arm64') {
            return false;
        }
        try {
            const hwaccels = execSync(
                `${ffmpegShellBin()} -hwaccels 2>/dev/null`,
                {
                    encoding: 'utf-8',
                    timeout: 5000,
                }
            );
            if (!hwaccels.includes('videotoolbox')) return false;

            const encoders = execSync(
                `${ffmpegShellBin()} -encoders 2>/dev/null`,
                {
                    encoding: 'utf-8',
                    timeout: 5000,
                }
            );
            if (!encoders.includes('h264_videotoolbox')) return false;

            const filters = execSync(
                `${ffmpegShellBin()} -filters 2>/dev/null`,
                {
                    encoding: 'utf-8',
                    timeout: 5000,
                }
            );
            return filters.includes('scale_vt');
        } catch {
            return false;
        }
    }

    /**
     * Probe per-stream start times grouped by codec type.
     */
    private async probeStreamStartTimes(
        inputPath: string
    ): Promise<{ video: number[]; audio: number[] }> {
        try {
            const { stdout } = await execFileAsync(
                ffprobeBin(),
                [
                    '-v',
                    'error',
                    '-show_entries',
                    'stream=codec_type,start_time',
                    '-of',
                    'json',
                    inputPath,
                ],
                { timeout: 30000 }
            );
            const data = JSON.parse(stdout);
            const video: number[] = [];
            const audio: number[] = [];
            for (const stream of data.streams ?? []) {
                const st = parseFloat(stream.start_time);
                if (stream.codec_type === 'video')
                    video.push(isNaN(st) ? 0 : st);
                else if (stream.codec_type === 'audio')
                    audio.push(isNaN(st) ? 0 : st);
            }
            return { video, audio };
        } catch {
            this.logger.warn('Could not probe stream start times');
            return { video: [], audio: [] };
        }
    }

    /**
     * Check whether all streams used by the encode config have aligned start times.
     * When aligned, fMP4 segments can be used safely. When misaligned, MPEG-TS
     * segments are needed because hls.js's TS→fMP4 transmuxer synchronizes
     * audio and video PTS during transmux.
     */
    private async areStreamStartTimesAligned(
        inputPath: string,
        encodeConfig: EncodeConfigDto
    ): Promise<boolean> {
        const startTimes = await this.probeStreamStartTimes(inputPath);

        const usedStartTimes: number[] = [];
        if (encodeConfig.type === 'video') {
            for (const r of encodeConfig.videoRenditions ?? []) {
                const idx = r.sourceTrackIndex ?? 0;
                if (idx < startTimes.video.length)
                    usedStartTimes.push(startTimes.video[idx]);
            }
        }
        for (const g of encodeConfig.audioGroups ?? []) {
            const idx = g.sourceTrackIndex;
            if (idx < startTimes.audio.length)
                usedStartTimes.push(startTimes.audio[idx]);
        }

        if (usedStartTimes.length < 2) return true;

        const maxStart = Math.max(...usedStartTimes);
        const minStart = Math.min(...usedStartTimes);
        const spread = maxStart - minStart;

        if (spread < 0.05) {
            this.logger.log(
                `Stream start times aligned (spread ${(spread * 1000).toFixed(0)}ms) — using fMP4 segments`
            );
            return true;
        }

        this.logger.log(
            `Stream start times misaligned (spread ${(spread * 1000).toFixed(0)}ms, min ${minStart.toFixed(3)}s, max ${maxStart.toFixed(3)}s) — falling back to MPEG-TS segments`
        );
        return false;
    }

    private async probeDuration(inputPath: string): Promise<number> {
        try {
            const { stdout } = await execFileAsync(
                ffprobeBin(),
                [
                    '-v',
                    'error',
                    '-show_entries',
                    'format=duration',
                    '-of',
                    'csv=p=0',
                    inputPath,
                ],
                { timeout: 30000 }
            );
            const duration = parseFloat(stdout.trim());
            return isNaN(duration) ? 0 : duration;
        } catch {
            this.logger.warn(
                'Could not probe input duration, progress will be unavailable'
            );
            return 0;
        }
    }

    private async probeFrameRate(inputPath: string): Promise<number> {
        try {
            const { stdout } = await execFileAsync(
                ffprobeBin(),
                [
                    '-v',
                    'error',
                    '-select_streams',
                    'v:0',
                    '-show_entries',
                    'stream=r_frame_rate',
                    '-of',
                    'csv=p=0',
                    inputPath,
                ],
                { timeout: 30000 }
            );
            const raw = stdout.trim();
            const parts = raw.split('/');
            if (parts.length === 2) {
                const num = parseFloat(parts[0]);
                const den = parseFloat(parts[1]);
                if (den > 0 && num > 0) return num / den;
            }
            const parsed = parseFloat(raw);
            return parsed > 0 ? parsed : 30;
        } catch {
            this.logger.warn(
                'Could not probe frame rate, defaulting to 30 fps'
            );
            return 30;
        }
    }

    private async probeGopDuration(
        inputPath: string,
        frameRate: number
    ): Promise<number | null> {
        try {
            const { stdout } = await execFileAsync(
                ffprobeBin(),
                [
                    '-v',
                    'error',
                    '-select_streams',
                    'v:0',
                    '-show_frames',
                    '-show_entries',
                    'frame=pict_type',
                    '-of',
                    'csv=p=0',
                    '-read_intervals',
                    '%+#200',
                    inputPath,
                ],
                { timeout: 60000 }
            );
            const frames = stdout
                .trim()
                .split('\n')
                .filter((l) => l.trim());
            let keyframeCount = 0;
            let firstKeyIdx = -1;
            let secondKeyIdx = -1;
            for (let i = 0; i < frames.length; i++) {
                if (frames[i].trim() === 'I') {
                    keyframeCount++;
                    if (keyframeCount === 1) firstKeyIdx = i;
                    else if (keyframeCount === 2) {
                        secondKeyIdx = i;
                        break;
                    }
                }
            }
            if (
                firstKeyIdx >= 0 &&
                secondKeyIdx > firstKeyIdx &&
                frameRate > 0
            ) {
                const gopFrames = secondKeyIdx - firstKeyIdx;
                const gopSeconds = gopFrames / frameRate;
                return Math.round(gopSeconds * 1000) / 1000;
            }
            return null;
        } catch {
            this.logger.warn('Could not probe GOP duration');
            return null;
        }
    }

    private async buildConcatFile(
        inputPath: string,
        segments: TrimSegmentDto[],
        outputDir: string
    ): Promise<string> {
        const lines = ['ffconcat version 1.0'];
        for (const seg of segments) {
            // Escape single quotes in path for ffconcat format
            const escapedPath = inputPath.replace(/'/g, "'\\''");
            lines.push(`file '${escapedPath}'`);
            lines.push(`inpoint ${seg.inSec}`);
            lines.push(`outpoint ${seg.outSec}`);
        }
        const concatPath = join(outputDir, 'concat.txt');
        await writeFile(concatPath, lines.join('\n'), 'utf-8');
        return concatPath;
    }

    private getX264Preset(height: number): string {
        if (height >= 1080) return 'veryfast';
        if (height >= 720) return 'faster';
        if (height >= 480) return 'fast';
        if (height >= 360) return 'medium';
        return 'slow';
    }

    /**
     * Spare NVDEC decode surfaces.
     *
     * Measured on the GTX 1050 with a six-rendition ladder, identical for direct
     * and concat inputs: 0-4 extra exhausts the pool mid-decode, 6-12 works, and
     * 16 or more makes cuvidCreateDecoder refuse to initialise at all
     * (CUDA_ERROR_INVALID_VALUE) because NVDEC caps total surfaces.
     *
     * So this is a fixed budget, not a per-rendition one: the ceiling belongs to
     * the decoder, not the ladder. Scaling it by rendition count reached 20 on a
     * six-rung ladder and broke every encode outright.
     */
    private static readonly EXTRA_HW_FRAMES = 8;

    private getNvencPreset(height: number): string {
        if (height >= 1080) return 'p4';
        if (height >= 720) return 'p5';
        if (height >= 480) return 'p5';
        if (height >= 360) return 'p6';
        return 'p7';
    }

    private bitrateToVbrQuality(bitrateKbps: number): string {
        const q = Math.max(0.1, Math.min(2.0, bitrateKbps / 128));
        return q.toFixed(1);
    }

    private bitrateToVideoCrf(
        bitrateKbps: number,
        width: number,
        height: number,
        fps: number
    ): number {
        // Bits per pixel must use the real frame rate: this assumed 30 fps, so a
        // 50 fps source was treated as having 66% more bits per pixel than it
        // does, and the quality target it derived demanded more than the rate cap
        // could pay for — the encoder rode the cap and motion fell apart.
        const bpp =
            (bitrateKbps * 1000) / (width * height * (fps > 0 ? fps : 30));
        const crf = 23 - Math.log2(bpp / 0.1) * 3;
        return Math.max(16, Math.min(34, Math.round(crf)));
    }

    private async buildVideoArgs(
        opts: EncodeOptions,
        useFmp4 = true
    ): Promise<string[]> {
        const { inputPath, outputDir, encodeConfig } = opts;
        const renditions = encodeConfig.videoRenditions!;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const sourceFrameRate = await this.probeFrameRate(inputPath);
        const gopFrames = Math.round(segmentDuration * sourceFrameRate);

        let hlsTime = segmentDuration;
        if (opts.byteRange !== false) {
            const sourceGopDuration = await this.probeGopDuration(
                inputPath,
                sourceFrameRate
            );
            if (sourceGopDuration && sourceGopDuration > 0) {
                hlsTime = sourceGopDuration;
                this.logger.log(
                    `Byte-range mode: using source GOP duration ${hlsTime}s for -hls_time (source: ${sourceFrameRate.toFixed(2)} fps, GOP: ${Math.round(hlsTime * sourceFrameRate)} frames)`
                );
            } else {
                this.logger.log(
                    `Byte-range mode: could not detect source GOP, using segment duration ${hlsTime}s for -hls_time`
                );
            }
        }

        this.logger.log(
            `Source frame rate: ${sourceFrameRate.toFixed(2)} fps, GOP: ${gopFrames} frames (${segmentDuration}s segments), hls_time: ${hlsTime}s`
        );
        const args: string[] = [];

        const hasReencode = renditions.some((r) => !r.copyStream);

        if (hasReencode && this.accelMode === 'nvidia') {
            // Every rendition branch holds references to decoded surfaces, so a
            // ladder drains NVDEC's pool: it then stops handing back frames and
            // reports "No decoder surfaces left". The decoder does not fail
            // cleanly — downstream this arrives as "Invalid data found when
            // processing input", which either kills the encode or, when the pool
            // recovers between frames, yields structurally valid H.264 built from
            // frames that were never decoded properly. That is the corruption in
            // #93. Ask for surfaces to spare, scaled to the ladder.
            args.push(
                '-extra_hw_frames',
                String(FfmpegService.EXTRA_HW_FRAMES),
                '-hwaccel',
                'cuda',
                '-hwaccel_output_format',
                'cuda'
            );
        } else if (hasReencode && this.accelMode === 'apple') {
            args.push(
                '-hwaccel',
                'videotoolbox',
                '-hwaccel_output_format',
                'videotoolbox_vld'
            );
        }

        if (encodeConfig.trimSegments?.length) {
            const concatPath = await this.buildConcatFile(
                inputPath,
                encodeConfig.trimSegments,
                outputDir
            );
            args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
        } else {
            args.push('-i', inputPath);
        }
        args.push('-threads', String(this.threads));
        args.push('-progress', 'pipe:2', '-stats_period', '1');

        const reencodeRenditions = renditions.filter((r) => !r.copyStream);
        const copyRenditions = renditions.filter((r) => r.copyStream);

        if (reencodeRenditions.length > 0) {
            const reencodeByTrack = new Map<
                number,
                { rendition: VideoRenditionDto; globalIndex: number }[]
            >();
            reencodeRenditions.forEach((r, i) => {
                const trackIdx = r.sourceTrackIndex ?? 0;
                if (!reencodeByTrack.has(trackIdx))
                    reencodeByTrack.set(trackIdx, []);
                reencodeByTrack
                    .get(trackIdx)!
                    .push({ rendition: r, globalIndex: i });
            });

            const filterParts: string[] = [];
            for (const [trackIdx, entries] of reencodeByTrack) {
                const splitOutputs = entries
                    .map((e) => `[reencode${e.globalIndex}]`)
                    .join('');
                filterParts.push(
                    `[0:v:${trackIdx}]split=${entries.length}${splitOutputs}`
                );
                for (const e of entries) {
                    let scalerExpr: string;
                    if (this.accelMode === 'nvidia') {
                        scalerExpr = `scale_cuda=${e.rendition.width}:${e.rendition.height}`;
                    } else if (this.accelMode === 'apple') {
                        scalerExpr = `scale_vt=w=${e.rendition.width}:h=${e.rendition.height}`;
                    } else {
                        scalerExpr = `scale=${e.rendition.width}:${e.rendition.height}`;
                    }
                    filterParts.push(
                        `[reencode${e.globalIndex}]${scalerExpr}[vout${e.globalIndex}]`
                    );
                }
            }
            args.push('-filter_complex', filterParts.join(';'));
        }

        // Map video streams: re-encoded first, then copy
        let videoOutputIndex = 0;
        const videoIndexMap: {
            rendition: VideoRenditionDto;
            outputIndex: number;
        }[] = [];

        for (let i = 0; i < reencodeRenditions.length; i++) {
            const r = reencodeRenditions[i];
            args.push('-map', `[vout${i}]`);

            if (this.accelMode === 'nvidia') {
                args.push(
                    `-c:v:${videoOutputIndex}`,
                    'h264_nvenc',
                    `-profile:v:${videoOutputIndex}`,
                    'high',
                    `-preset:v:${videoOutputIndex}`,
                    this.getNvencPreset(r.height),
                    `-tune:v:${videoOutputIndex}`,
                    'hq',
                    `-rc:v:${videoOutputIndex}`,
                    'vbr'
                );
                if (r.vbr) {
                    const cq = this.bitrateToVideoCrf(
                        r.videoBitrateKbps,
                        r.width,
                        r.height,
                        sourceFrameRate
                    );
                    args.push(
                        `-cq:v:${videoOutputIndex}`,
                        `${cq}`,
                        `-b:v:${videoOutputIndex}`,
                        '0',
                        `-maxrate:v:${videoOutputIndex}`,
                        `${r.videoBitrateKbps}k`,
                        `-bufsize:v:${videoOutputIndex}`,
                        `${Math.round(r.videoBitrateKbps * 1.5)}k`
                    );
                } else {
                    args.push(
                        `-b:v:${videoOutputIndex}`,
                        `${r.videoBitrateKbps}k`,
                        `-maxrate:v:${videoOutputIndex}`,
                        `${Math.round(r.videoBitrateKbps * 1.07)}k`,
                        `-bufsize:v:${videoOutputIndex}`,
                        `${Math.round(r.videoBitrateKbps * 1.5)}k`
                    );
                }
            } else if (this.accelMode === 'apple') {
                args.push(
                    `-c:v:${videoOutputIndex}`,
                    'h264_videotoolbox',
                    `-allow_sw:v:${videoOutputIndex}`,
                    '1',
                    `-realtime:v:${videoOutputIndex}`,
                    '0',
                    `-profile:v:${videoOutputIndex}`,
                    'high'
                );
                args.push(
                    `-b:v:${videoOutputIndex}`,
                    `${r.videoBitrateKbps}k`,
                    `-maxrate:v:${videoOutputIndex}`,
                    `${Math.round(r.videoBitrateKbps * (r.vbr ? 1.5 : 1.07))}k`,
                    `-bufsize:v:${videoOutputIndex}`,
                    `${Math.round(r.videoBitrateKbps * (r.vbr ? 2 : 1.5))}k`
                );
            } else {
                args.push(
                    `-c:v:${videoOutputIndex}`,
                    'libx264',
                    `-preset:v:${videoOutputIndex}`,
                    this.getX264Preset(r.height)
                );
                if (r.vbr) {
                    const crf = this.bitrateToVideoCrf(
                        r.videoBitrateKbps,
                        r.width,
                        r.height,
                        sourceFrameRate
                    );
                    args.push(
                        `-crf:v:${videoOutputIndex}`,
                        `${crf}`,
                        `-maxrate:v:${videoOutputIndex}`,
                        `${r.videoBitrateKbps}k`,
                        `-bufsize:v:${videoOutputIndex}`,
                        `${Math.round(r.videoBitrateKbps * 1.5)}k`
                    );
                } else {
                    args.push(
                        `-b:v:${videoOutputIndex}`,
                        `${r.videoBitrateKbps}k`,
                        `-maxrate:v:${videoOutputIndex}`,
                        `${Math.round(r.videoBitrateKbps * 1.07)}k`,
                        `-bufsize:v:${videoOutputIndex}`,
                        `${Math.round(r.videoBitrateKbps * 1.5)}k`
                    );
                }
            }
            args.push(
                `-g:v:${videoOutputIndex}`,
                `${gopFrames}`,
                `-keyint_min:v:${videoOutputIndex}`,
                `${gopFrames}`
            );
            videoIndexMap.push({ rendition: r, outputIndex: videoOutputIndex });
            videoOutputIndex++;
        }

        for (const r of copyRenditions) {
            const srcIdx = r.sourceTrackIndex ?? 0;
            args.push('-map', `0:v:${srcIdx}`);
            args.push(`-c:v:${videoOutputIndex}`, 'copy');
            videoIndexMap.push({ rendition: r, outputIndex: videoOutputIndex });
            videoOutputIndex++;
        }

        // Build unique audio outputs: one per (group, sourceTrack) pair
        const audioOutputs: { group: AudioGroupDto; outputIndex: number }[] =
            [];
        let audioOutputIndex = 0;

        for (const group of audioGroups) {
            args.push('-map', `0:a:${group.sourceTrackIndex}`);
            if (group.copyStream) {
                args.push(`-c:a:${audioOutputIndex}`, 'copy');
            } else {
                args.push(`-c:a:${audioOutputIndex}`, 'aac');
                if (group.vbr) {
                    args.push(
                        `-q:a:${audioOutputIndex}`,
                        this.bitrateToVbrQuality(group.audioBitrateKbps)
                    );
                } else {
                    args.push(
                        `-b:a:${audioOutputIndex}`,
                        `${group.audioBitrateKbps}k`
                    );
                }
                const channels =
                    !group.vbr && group.audioBitrateKbps < 100
                        ? 1
                        : group.channels;
                args.push(`-ac:a:${audioOutputIndex}`, `${channels}`);
            }
            audioOutputs.push({ group, outputIndex: audioOutputIndex });
            audioOutputIndex++;
        }

        // HLS output options — use fMP4 when stream start times are aligned (preferred:
        // CMAF-compatible, lower overhead). Fall back to MPEG-TS when misaligned, because
        // hls.js's TS→fMP4 transmuxer synchronizes audio/video PTS during transmux,
        // while fMP4 segments are appended directly and rely on tfdt alignment.
        const segExt = useFmp4 ? 'm4s' : 'ts';
        args.push(
            '-f',
            'hls',
            '-hls_time',
            String(hlsTime),
            '-hls_playlist_type',
            'vod',
            '-hls_flags',
            'independent_segments',
            '-hls_segment_type',
            useFmp4 ? 'fmp4' : 'mpegts',
            '-master_pl_name',
            'master.m3u8'
        );
        if (useFmp4) {
            args.push(
                '-hls_fmp4_init_filename',
                'init.mp4',
                '-movflags',
                '+negative_cts_offsets+default_base_moof'
            );
        }

        const multiTrack =
            new Set(renditions.map((r) => r.sourceTrackIndex ?? 0)).size > 1;

        const varParts: string[] = [];
        for (const { rendition, outputIndex } of videoIndexMap) {
            const name = this.buildVideoStreamName(rendition, multiTrack);
            let part = `v:${outputIndex},agroup:${rendition.audioGroupId},name:${name}`;
            varParts.push(part);
        }

        // Audio entries with group, name, and language
        const defaultedGroups = new Set<string>();
        for (const { group, outputIndex } of audioOutputs) {
            const name = this.buildAudioStreamName(group);
            let part = `a:${outputIndex},agroup:${group.id},name:${name}`;
            if (group.language) {
                part += `,language:${group.language.toLowerCase()}`;
            }
            const isDefault = !defaultedGroups.has(group.id);
            if (isDefault) defaultedGroups.add(group.id);
            part += `,default:${isDefault ? 'yes' : 'no'}`;
            varParts.push(part);
        }

        args.push('-var_stream_map', varParts.join(' '));

        args.push(
            '-hls_segment_filename',
            join(outputDir, 'stream_%v', `segment_%05d.${segExt}`),
            join(outputDir, 'stream_%v', 'playlist.m3u8')
        );

        return args;
    }

    private async buildAudioArgs(
        opts: EncodeOptions,
        useFmp4 = true
    ): Promise<string[]> {
        const { inputPath, outputDir, encodeConfig } = opts;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const args: string[] = [];

        if (encodeConfig.trimSegments?.length) {
            const concatPath = await this.buildConcatFile(
                inputPath,
                encodeConfig.trimSegments,
                outputDir
            );
            args.push('-f', 'concat', '-safe', '0', '-i', concatPath);
        } else {
            args.push('-i', inputPath);
        }
        args.push('-threads', String(this.threads));

        args.push('-progress', 'pipe:2', '-stats_period', '1');
        args.push('-vn');

        audioGroups.forEach((group, i) => {
            args.push('-map', `0:a:${group.sourceTrackIndex}`);
            if (group.copyStream) {
                args.push(`-c:a:${i}`, 'copy');
            } else {
                args.push(`-c:a:${i}`, 'aac');
                if (group.vbr) {
                    args.push(
                        `-q:a:${i}`,
                        this.bitrateToVbrQuality(group.audioBitrateKbps)
                    );
                } else {
                    args.push(`-b:a:${i}`, `${group.audioBitrateKbps}k`);
                }
                const channels =
                    !group.vbr && group.audioBitrateKbps < 100
                        ? 1
                        : group.channels;
                args.push(`-ac:a:${i}`, `${channels}`);
            }
        });

        const varParts: string[] = [];
        for (let i = 0; i < audioGroups.length; i++) {
            const group = audioGroups[i];
            const name = this.buildAudioStreamName(group);
            varParts.push(`a:${i},name:${name}`);
        }

        const segExt = useFmp4 ? 'm4s' : 'ts';
        args.push(
            '-f',
            'hls',
            '-hls_time',
            String(segmentDuration),
            '-hls_playlist_type',
            'vod',
            '-hls_flags',
            'independent_segments',
            '-hls_segment_type',
            useFmp4 ? 'fmp4' : 'mpegts',
            '-master_pl_name',
            'master.m3u8'
        );
        if (useFmp4) {
            args.push(
                '-hls_fmp4_init_filename',
                'init.mp4',
                '-movflags',
                '+negative_cts_offsets+default_base_moof'
            );
        }

        args.push(
            '-var_stream_map',
            varParts.join(' '),
            '-hls_segment_filename',
            join(outputDir, 'stream_%v', `segment_%05d.${segExt}`),
            join(outputDir, 'stream_%v', 'playlist.m3u8')
        );

        return args;
    }

    private parseProgressTime(data: string): number | null {
        const usMatch = data.match(/out_time_us=(\d+)/);
        if (usMatch) {
            return parseInt(usMatch[1], 10) / 1_000_000;
        }

        const timeMatch = data.match(/out_time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
        if (timeMatch) {
            const h = parseInt(timeMatch[1], 10);
            const m = parseInt(timeMatch[2], 10);
            const s = parseInt(timeMatch[3], 10);
            const frac = parseFloat(`0.${timeMatch[4]}`);
            return h * 3600 + m * 60 + s + frac;
        }

        return null;
    }

    async encode(opts: EncodeOptions): Promise<EncodeResult> {
        const { outputDir, encodeConfig, onProgress } = opts;
        const type = encodeConfig.type;

        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }

        // Create output subdirectories
        if (type === 'video') {
            const totalStreams =
                (encodeConfig.videoRenditions?.length ?? 0) +
                (encodeConfig.audioGroups?.length ?? 0);
            for (let i = 0; i < totalStreams; i++) {
                const dir = join(outputDir, `stream_${i}`);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            }
        } else {
            const numGroups = encodeConfig.audioGroups?.length ?? 1;
            for (let i = 0; i < numGroups; i++) {
                const dir = join(outputDir, `stream_${i}`);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            }
        }

        // Use fMP4 when stream start times are aligned (CMAF-compatible, lower overhead).
        // Fall back to MPEG-TS when misaligned — hls.js's transmuxer fixes sync for TS.
        const useFmp4 = await this.areStreamStartTimesAligned(
            opts.inputPath,
            encodeConfig
        );

        const totalDuration = encodeConfig.trimSegments?.length
            ? encodeConfig.trimSegments.reduce(
                  (sum, s) => sum + (s.outSec - s.inSec),
                  0
              )
            : await this.probeDuration(opts.inputPath);
        const args =
            type === 'video'
                ? await this.buildVideoArgs(opts, useFmp4)
                : await this.buildAudioArgs(opts, useFmp4);

        this.logger.debug(`FFmpeg args: ffmpeg ${args.join(' ')}`);

        return new Promise<EncodeResult>((resolve, reject) => {
            const proc = spawn(ffmpegBin(), args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.activeProcess = proc;

            let stderrBuffer = '';
            let lastProgress = 0;

            proc.stderr?.on('data', (chunk: Buffer) => {
                try {
                    const text = chunk.toString();
                    stderrBuffer += text;

                    if (stderrBuffer.length > 8192) {
                        stderrBuffer = stderrBuffer.slice(-8192);
                    }

                    if (totalDuration > 0) {
                        const currentTime = this.parseProgressTime(text);
                        if (currentTime !== null) {
                            const percent = Math.min(
                                99.9,
                                (currentTime / totalDuration) * 100
                            );
                            if (percent - lastProgress >= 0.5) {
                                lastProgress = percent;
                                onProgress(Math.round(percent * 10) / 10);
                            }
                        }
                    }
                } catch {
                    // Never let stderr parsing crash the process
                }
            });

            proc.stdout?.resume();

            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                this.activeProcess = null;
                if (timeoutTimer) clearTimeout(timeoutTimer);
                if (err) {
                    reject(err);
                    return;
                }

                (async () => {
                    if (opts.preByteRangeHook) {
                        await opts.preByteRangeHook(outputDir);
                    }

                    if (opts.byteRange !== false) {
                        const maxBytes =
                            opts.byteRangeMaxFileSizeBytes ?? 500 * 1024 * 1024;
                        await this.convertToByteRange(outputDir, maxBytes);
                    }

                    // One spec-correct master, angles and all. Splitting it per
                    // angle is the player's job now (see the hls package's
                    // extractAnglePlaylist / extractAudioOnlyPlaylist).
                    if (type === 'video') {
                        await this.fixMasterPlaylist(outputDir, encodeConfig);
                    } else {
                        await this.fixAudioOnlyMasterPlaylist(
                            outputDir,
                            encodeConfig
                        );
                    }
                    resolve({
                        outputDir,
                        masterPlaylist: 'master.m3u8',
                        segmentFormat: useFmp4 ? 'fmp4' : 'mpegts',
                    });
                })().catch(reject);
            };

            proc.on('error', (err) => {
                settle(new Error(`FFmpeg spawn error: ${err.message}`));
            });

            proc.on('close', (code, signal) => {
                if (code === 0) {
                    onProgress(100);
                    settle();
                } else {
                    const tail = stderrBuffer.slice(-2000);
                    settle(
                        new Error(
                            `FFmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr tail:\n${tail}`
                        )
                    );
                }
            });

            let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
            if (this.timeoutMs > 0) {
                timeoutTimer = setTimeout(() => {
                    if (!settled) {
                        this.logger.warn(
                            `FFmpeg timeout (${this.timeoutMs}ms) for session ${opts.sessionId}, killing process`
                        );
                        proc.kill('SIGKILL');
                        settle(
                            new Error(
                                `FFmpeg timed out after ${this.timeoutMs}ms`
                            )
                        );
                    }
                }, this.timeoutMs);
            }
        });
    }

    private async convertToByteRange(
        outputDir: string,
        maxFileSizeBytes: number
    ): Promise<void> {
        const tsPath = join(__dirname, 'byte-range.worker.ts');
        const useTsWorker = existsSync(tsPath);
        const workerPath = useTsWorker
            ? tsPath
            : join(__dirname, 'byte-range.worker.js');

        return new Promise<void>((resolve, reject) => {
            const worker = new Worker(workerPath, {
                workerData: { outputDir, maxFileSizeBytes },
                ...(useTsWorker
                    ? { execArgv: ['--require', 'ts-node/register'] }
                    : {}),
            });

            worker.on('message', (msg) => {
                this.logger.log(
                    `Byte-range conversion complete for ${msg.streamCount} stream(s) (max ${Math.round(maxFileSizeBytes / 1024 / 1024)} MB per file)`
                );
                resolve();
            });

            worker.on('error', (err) => {
                reject(new Error(`Byte-range worker error: ${err.message}`));
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(
                        new Error(`Byte-range worker exited with code ${code}`)
                    );
                }
            });
        });
    }

    private async fixMasterPlaylist(
        outputDir: string,
        config: EncodeConfigDto
    ): Promise<void> {
        const masterPath = join(outputDir, 'master.m3u8');
        let content: string;
        try {
            content = await readFile(masterPath, 'utf-8');
        } catch {
            return;
        }
        content = this.fixMasterPlaylistAudioNames(content, config);
        content = this.fixMasterPlaylistVideoGroups(content, config);
        content = content.replace(
            /LANGUAGE="([^"]+)"/g,
            (_, code: string) => `LANGUAGE="${code.toLowerCase()}"`
        );
        await writeFile(masterPath, content, 'utf-8');
    }

    /**
     * Rewrite the FFmpeg-generated audio-only master.m3u8 to add proper
     * EXT-X-MEDIA entries with language tags and GROUP-IDs per quality tier.
     */
    private async fixAudioOnlyMasterPlaylist(
        outputDir: string,
        config: EncodeConfigDto
    ): Promise<void> {
        const audioGroups = config.audioGroups ?? [];
        if (audioGroups.length === 0) return;

        const masterPath = join(outputDir, 'master.m3u8');
        let raw: string;
        try {
            raw = await readFile(masterPath, 'utf-8');
        } catch {
            return;
        }
        const versionMatch = raw.match(/#EXT-X-VERSION:\d+/);
        const extVersion = versionMatch?.[0] ?? '#EXT-X-VERSION:7';

        const content = this.buildAudioOnlyMasterContent(
            extVersion,
            audioGroups
        );
        await writeFile(masterPath, content, 'utf-8');

        this.logger.debug(
            `fixAudioOnlyMasterPlaylist: rewrote master.m3u8 with ${audioGroups.length} audio group(s)`
        );
    }

    private fixMasterPlaylistAudioNames(
        content: string,
        config: EncodeConfigDto
    ): string {
        const audioGroups = config.audioGroups ?? [];
        if (audioGroups.length === 0) return content;

        // Determine if all audio groups share the same language.
        // When they do, they represent quality tiers (not language alternatives),
        // so they must share the same NAME to prevent HLS players from showing
        // them as separate selectable audio tracks.
        const uniqueLanguages = new Set(
            audioGroups.map((g) => g.language ?? '')
        );
        const isSingleLanguage = uniqueLanguages.size <= 1;

        const nameByUri = new Map<string, string>();
        for (const group of audioGroups) {
            const streamName = this.buildAudioStreamName(group);
            const uri = `stream_${streamName}/playlist.m3u8`;
            const name = isSingleLanguage
                ? (group.language ?? 'Audio')
                : (group.label ?? group.language ?? 'Audio');
            nameByUri.set(uri, name);
        }

        return content
            .split('\n')
            .map((line) => {
                if (
                    !line.startsWith('#EXT-X-MEDIA:') ||
                    !line.includes('TYPE=AUDIO')
                ) {
                    return line;
                }
                const uriMatch = line.match(/URI="([^"]+)"/);
                if (!uriMatch) return line;

                const name = nameByUri.get(uriMatch[1]);
                if (!name) return line;
                return line.replace(/NAME="[^"]*"/, `NAME="${name}"`);
            })
            .join('\n');
    }

    /**
     * Build a proper audio-only master playlist with per-tier GROUP-IDs,
     * language-based EXT-X-MEDIA entries, and one EXT-X-STREAM-INF per tier.
     */
    private buildAudioOnlyMasterContent(
        extVersion: string,
        audioGroups: AudioGroupDto[]
    ): string {
        const parts: string[] = ['#EXTM3U', extVersion];

        // Group by tier ID (e.g. "hd", "mid", "low")
        const tierMap = new Map<string, AudioGroupDto[]>();
        for (const group of audioGroups) {
            const tierId = group.id;
            if (!tierMap.has(tierId)) tierMap.set(tierId, []);
            tierMap.get(tierId)!.push(group);
        }

        const tiers = [...tierMap.entries()];

        // When all audio groups share one language, use a uniform NAME
        // so HLS players treat them as quality tiers, not separate tracks.
        const allLanguages = new Set(audioGroups.map((g) => g.language ?? ''));
        const singleLang = allLanguages.size <= 1;

        // EXT-X-MEDIA entries per tier
        for (const [tierId, groups] of tiers) {
            let isFirstInTier = true;
            for (const group of groups) {
                const streamName = this.buildAudioStreamName(group);
                const uri = `stream_${streamName}/playlist.m3u8`;
                const name = singleLang
                    ? (group.language ?? 'Audio')
                    : (group.label ?? group.language ?? 'Audio');
                const lang = group.language
                    ? `,LANGUAGE="${group.language.toLowerCase()}"`
                    : '';

                parts.push(
                    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${tierId}",NAME="${name}",DEFAULT=${isFirstInTier ? 'YES' : 'NO'}${lang},URI="${uri}"`
                );
                isFirstInTier = false;
            }
        }

        // One EXT-X-STREAM-INF per tier (highest bandwidth in tier)
        parts.push('');
        for (const [tierId, groups] of tiers) {
            const maxBitrate = Math.max(
                ...groups.map((g) => g.audioBitrateKbps)
            );
            const bandwidth = maxBitrate * 1000;
            const defaultGroup = groups[0];
            const defaultStreamName = this.buildAudioStreamName(defaultGroup);

            parts.push(
                `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="mp4a.40.2",AUDIO="${tierId}"`,
                `stream_${defaultStreamName}/playlist.m3u8`
            );
        }

        return parts.join('\n') + '\n';
    }

    /**
     * Add VIDEO attribute to each EXT-X-STREAM-INF identifying the angle.
     * Uses positional matching (re-encode first, then copy) and derives the
     * angle name from videoTrackNames + sourceTrackIndex.
     */
    private fixMasterPlaylistVideoGroups(
        content: string,
        config: EncodeConfigDto
    ): string {
        const renditions = config.videoRenditions ?? [];
        if (renditions.length === 0) return content;

        const uniqueTracks = new Set(
            renditions.map((r) => r.sourceTrackIndex ?? 0)
        );
        if (uniqueTracks.size <= 1) return content;

        const nameByTrackIndex = new Map<number, string>();
        for (const tn of config.videoTrackNames ?? []) {
            nameByTrackIndex.set(tn.index, tn.name ?? `Angle ${tn.index}`);
        }
        for (const idx of uniqueTracks) {
            if (!nameByTrackIndex.has(idx)) {
                nameByTrackIndex.set(idx, `Angle ${idx}`);
            }
        }

        const sanitize = (s: string): string =>
            s
                .replace(/[^a-zA-Z0-9_-]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '') || 'angle';

        const orderedRenditions = [
            ...renditions.filter((r) => !r.copyStream),
            ...renditions.filter((r) => r.copyStream),
        ];

        const lines = content.split('\n');
        const result: string[] = [];
        let videoEntryIndex = 0;
        let insertedVideoMedia = false;
        const insertedGroupIds = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (
                !insertedVideoMedia &&
                (line.startsWith('#EXT-X-MEDIA:') ||
                    line.startsWith('#EXT-X-STREAM-INF:'))
            ) {
                for (const [, angleName] of nameByTrackIndex) {
                    const groupId = sanitize(angleName);
                    if (insertedGroupIds.has(groupId)) continue;
                    insertedGroupIds.add(groupId);
                    const isDefault = insertedGroupIds.size === 1;
                    result.push(
                        `#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${groupId}",NAME="${angleName}",DEFAULT=${isDefault ? 'YES' : 'NO'}`
                    );
                }
                insertedVideoMedia = true;
            }

            if (
                line.startsWith('#EXT-X-STREAM-INF:') &&
                videoEntryIndex < orderedRenditions.length
            ) {
                const rendition = orderedRenditions[videoEntryIndex];
                const angleName =
                    nameByTrackIndex.get(rendition.sourceTrackIndex ?? 0) ??
                    'Angle 0';
                const groupId = sanitize(angleName);
                const newLine = line.includes('AUDIO=')
                    ? line.replace(
                          /AUDIO="([^"]+)"/,
                          `VIDEO="${groupId}",AUDIO="$1"`
                      )
                    : `${line},VIDEO="${groupId}"`;
                result.push(newLine);
                videoEntryIndex++;
                continue;
            }

            result.push(line);
        }

        return result.join('\n');
    }

    private buildVideoStreamName(
        rendition: VideoRenditionDto,
        multiTrack: boolean
    ): string {
        const base = (rendition.label ?? `${rendition.height}p`).replace(
            /\s+/g,
            '_'
        );
        if (multiTrack) {
            return `${base}_t${rendition.sourceTrackIndex ?? 0}_${rendition.width}x${rendition.height}`;
        }
        return `${base}_${rendition.width}x${rendition.height}`;
    }

    /**
     * Build a unique stream name for an audio group by combining tier ID and
     * label. Ensures each tier×language combination gets its own stream
     * directory so that different quality tiers don't collide.
     */
    private buildAudioStreamName(group: AudioGroupDto): string {
        const label = (group.label ?? `${group.audioBitrateKbps}kbps`).replace(
            /\s+/g,
            '_'
        );
        return `${group.id}_${label}`;
    }

    killActiveProcess(): void {
        if (this.activeProcess && !this.activeProcess.killed) {
            this.logger.log('Killing active FFmpeg process (user cancel)');
            this.activeProcess.kill('SIGTERM');
        }
    }

    isGpuAvailable(): boolean {
        return this.accelMode !== 'cpu';
    }

    getAccelMode(): AccelMode {
        return this.accelMode;
    }
}
