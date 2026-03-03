import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { spawn, execSync, type ChildProcess } from 'child_process';
import {
    mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync,
    readdirSync, statSync, openSync, writeSync, closeSync,
} from 'fs';
import { join } from 'path';
import type { EncodeConfigDto, VideoRenditionDto, AudioGroupDto } from '../dto/encode-config.dto.js';
import dotenv from 'dotenv';

dotenv.config();

export interface EncodeOptions {
    sessionId: string;
    inputPath: string;
    outputDir: string;
    encodeConfig: EncodeConfigDto;
    onProgress: (percent: number) => void;
    byteRange?: boolean;
    byteRangeMaxFileSizeBytes?: number;
}

export interface AnglePlaylist {
    name: string;
    filename: string;
}

export interface EncodeResult {
    outputDir: string;
    masterPlaylist: string;
    anglePlaylists: AnglePlaylist[];
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
                this.logger.log('NVIDIA GPU detected, using NVENC acceleration');
                break;
            case 'apple':
                this.logger.log('Apple Silicon detected, using VideoToolbox acceleration');
                break;
            default:
                this.logger.log('No GPU found, using CPU encoding');
        }
        this.logger.log(`FFmpeg threads: ${this.threads}`);
    }

    async onModuleDestroy(): Promise<void> {
        if (this.activeProcess && !this.activeProcess.killed) {
            this.logger.log(
                'Shutting down: killing active FFmpeg process...',
            );
            this.activeProcess.kill('SIGTERM');

            await new Promise<void>((resolve) => {
                const forceKillTimer = setTimeout(() => {
                    if (
                        this.activeProcess &&
                        !this.activeProcess.killed
                    ) {
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
            const hwaccels = execSync('ffmpeg -hwaccels 2>/dev/null', {
                encoding: 'utf-8',
                timeout: 5000,
            });
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
            const hwaccels = execSync('ffmpeg -hwaccels 2>/dev/null', {
                encoding: 'utf-8',
                timeout: 5000,
            });
            if (!hwaccels.includes('videotoolbox')) return false;

            const encoders = execSync('ffmpeg -encoders 2>/dev/null', {
                encoding: 'utf-8',
                timeout: 5000,
            });
            if (!encoders.includes('h264_videotoolbox')) return false;

            const filters = execSync('ffmpeg -filters 2>/dev/null', {
                encoding: 'utf-8',
                timeout: 5000,
            });
            return filters.includes('scale_vt');
        } catch {
            return false;
        }
    }

    private probeDuration(inputPath: string): number {
        try {
            const output = execSync(
                `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
                { encoding: 'utf-8', timeout: 30000 },
            );
            const duration = parseFloat(output.trim());
            return isNaN(duration) ? 0 : duration;
        } catch {
            this.logger.warn('Could not probe input duration, progress will be unavailable');
            return 0;
        }
    }

    private probeFrameRate(inputPath: string): number {
        try {
            const output = execSync(
                `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "${inputPath}"`,
                { encoding: 'utf-8', timeout: 30000 },
            );
            const raw = output.trim();
            const parts = raw.split('/');
            if (parts.length === 2) {
                const num = parseFloat(parts[0]);
                const den = parseFloat(parts[1]);
                if (den > 0 && num > 0) return num / den;
            }
            const parsed = parseFloat(raw);
            return parsed > 0 ? parsed : 30;
        } catch {
            this.logger.warn('Could not probe frame rate, defaulting to 30 fps');
            return 30;
        }
    }

    private probeGopDuration(inputPath: string, frameRate: number): number | null {
        try {
            const output = execSync(
                `ffprobe -v error -select_streams v:0 -show_frames -show_entries frame=pict_type -of csv=p=0 -read_intervals "%+#200" "${inputPath}"`,
                { encoding: 'utf-8', timeout: 60000 },
            );
            const frames = output.trim().split('\n').filter(l => l.trim());
            let keyframeCount = 0;
            let firstKeyIdx = -1;
            let secondKeyIdx = -1;
            for (let i = 0; i < frames.length; i++) {
                if (frames[i].trim() === 'I') {
                    keyframeCount++;
                    if (keyframeCount === 1) firstKeyIdx = i;
                    else if (keyframeCount === 2) { secondKeyIdx = i; break; }
                }
            }
            if (firstKeyIdx >= 0 && secondKeyIdx > firstKeyIdx && frameRate > 0) {
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

    private getX264Preset(height: number): string {
        if (height >= 1080) return 'veryfast';
        if (height >= 720) return 'faster';
        if (height >= 480) return 'fast';
        if (height >= 360) return 'medium';
        return 'slow';
    }

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

    private bitrateToVideoCrf(bitrateKbps: number, width: number, height: number): number {
        const bpp = (bitrateKbps * 1000) / (width * height * 30);
        const crf = 23 - Math.log2(bpp / 0.1) * 3;
        return Math.max(16, Math.min(34, Math.round(crf)));
    }

    private buildVideoArgs(opts: EncodeOptions): string[] {
        const { inputPath, outputDir, encodeConfig } = opts;
        const renditions = encodeConfig.videoRenditions!;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const sourceFrameRate = this.probeFrameRate(inputPath);
        const gopFrames = Math.round(segmentDuration * sourceFrameRate);

        let hlsTime = segmentDuration;
        if (opts.byteRange !== false) {
            const sourceGopDuration = this.probeGopDuration(inputPath, sourceFrameRate);
            if (sourceGopDuration && sourceGopDuration > 0) {
                hlsTime = sourceGopDuration;
                this.logger.log(
                    `Byte-range mode: using source GOP duration ${hlsTime}s for -hls_time (source: ${sourceFrameRate.toFixed(2)} fps, GOP: ${Math.round(hlsTime * sourceFrameRate)} frames)`,
                );
            } else {
                this.logger.log(
                    `Byte-range mode: could not detect source GOP, using segment duration ${hlsTime}s for -hls_time`,
                );
            }
        }

        this.logger.log(
            `Source frame rate: ${sourceFrameRate.toFixed(2)} fps, GOP: ${gopFrames} frames (${segmentDuration}s segments), hls_time: ${hlsTime}s`,
        );
        const args: string[] = [];

        const hasReencode = renditions.some(r => !r.copyStream);

        if (hasReencode && this.accelMode === 'nvidia') {
            args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
        } else if (hasReencode && this.accelMode === 'apple') {
            args.push('-hwaccel', 'videotoolbox', '-hwaccel_output_format', 'videotoolbox_vld');
        }
        args.push('-i', inputPath);
        args.push('-threads', String(this.threads));
        args.push('-progress', 'pipe:2', '-stats_period', '1');

        const reencodeRenditions = renditions.filter(r => !r.copyStream);
        const copyRenditions = renditions.filter(r => r.copyStream);

        if (reencodeRenditions.length > 0) {
            const reencodeByTrack = new Map<number, { rendition: VideoRenditionDto; globalIndex: number }[]>();
            reencodeRenditions.forEach((r, i) => {
                const trackIdx = r.sourceTrackIndex ?? 0;
                if (!reencodeByTrack.has(trackIdx)) reencodeByTrack.set(trackIdx, []);
                reencodeByTrack.get(trackIdx)!.push({ rendition: r, globalIndex: i });
            });

            const filterParts: string[] = [];
            for (const [trackIdx, entries] of reencodeByTrack) {
                const splitOutputs = entries.map(e => `[reencode${e.globalIndex}]`).join('');
                filterParts.push(`[0:v:${trackIdx}]split=${entries.length}${splitOutputs}`);
                for (const e of entries) {
                    let scalerExpr: string;
                    if (this.accelMode === 'nvidia') {
                        scalerExpr = `scale_cuda=${e.rendition.width}:${e.rendition.height}`;
                    } else if (this.accelMode === 'apple') {
                        scalerExpr = `scale_vt=w=${e.rendition.width}:h=${e.rendition.height}`;
                    } else {
                        scalerExpr = `scale=${e.rendition.width}:${e.rendition.height}`;
                    }
                    filterParts.push(`[reencode${e.globalIndex}]${scalerExpr}[vout${e.globalIndex}]`);
                }
            }
            args.push('-filter_complex', filterParts.join(';'));
        }

        // Map video streams: re-encoded first, then copy
        let videoOutputIndex = 0;
        const videoIndexMap: { rendition: VideoRenditionDto; outputIndex: number }[] = [];

        for (let i = 0; i < reencodeRenditions.length; i++) {
            const r = reencodeRenditions[i];
            args.push('-map', `[vout${i}]`);

            if (this.accelMode === 'nvidia') {
                args.push(
                    `-c:v:${videoOutputIndex}`, 'h264_nvenc',
                    `-preset:v:${videoOutputIndex}`, this.getNvencPreset(r.height),
                    `-tune:v:${videoOutputIndex}`, 'hq',
                    `-rc:v:${videoOutputIndex}`, 'vbr',
                );
                if (r.vbr) {
                    const cq = this.bitrateToVideoCrf(r.videoBitrateKbps, r.width, r.height);
                    args.push(
                        `-cq:v:${videoOutputIndex}`, `${cq}`,
                        `-b:v:${videoOutputIndex}`, '0',
                        `-maxrate:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                        `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.5)}k`,
                    );
                } else {
                    args.push(
                        `-b:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                        `-maxrate:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.07)}k`,
                        `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.5)}k`,
                    );
                }
            } else if (this.accelMode === 'apple') {
                args.push(
                    `-c:v:${videoOutputIndex}`, 'h264_videotoolbox',
                    `-allow_sw:v:${videoOutputIndex}`, '1',
                    `-realtime:v:${videoOutputIndex}`, '0',
                    `-profile:v:${videoOutputIndex}`, 'high',
                );
                args.push(
                    `-b:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                    `-maxrate:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * (r.vbr ? 1.5 : 1.07))}k`,
                    `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * (r.vbr ? 2 : 1.5))}k`,
                );
            } else {
                args.push(
                    `-c:v:${videoOutputIndex}`, 'libx264',
                    `-preset:v:${videoOutputIndex}`, this.getX264Preset(r.height),
                );
                if (r.vbr) {
                    const crf = this.bitrateToVideoCrf(r.videoBitrateKbps, r.width, r.height);
                    args.push(
                        `-crf:v:${videoOutputIndex}`, `${crf}`,
                        `-maxrate:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                        `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.5)}k`,
                    );
                } else {
                    args.push(
                        `-b:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                        `-maxrate:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.07)}k`,
                        `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.5)}k`,
                    );
                }
            }
            args.push(
                `-g:v:${videoOutputIndex}`, `${gopFrames}`,
                `-keyint_min:v:${videoOutputIndex}`, `${gopFrames}`,
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
        const audioOutputs: { group: AudioGroupDto; outputIndex: number }[] = [];
        let audioOutputIndex = 0;

        for (const group of audioGroups) {
            args.push('-map', `0:a:${group.sourceTrackIndex}`);
            if (group.copyStream) {
                args.push(`-c:a:${audioOutputIndex}`, 'copy');
            } else {
                args.push(`-c:a:${audioOutputIndex}`, 'aac');
                if (group.vbr) {
                    args.push(`-q:a:${audioOutputIndex}`, this.bitrateToVbrQuality(group.audioBitrateKbps));
                } else {
                    args.push(`-b:a:${audioOutputIndex}`, `${group.audioBitrateKbps}k`);
                }
                const channels = (!group.vbr && group.audioBitrateKbps < 100) ? 1 : group.channels;
                args.push(`-ac:a:${audioOutputIndex}`, `${channels}`);
            }
            audioOutputs.push({ group, outputIndex: audioOutputIndex });
            audioOutputIndex++;
        }

        // HLS output options
        args.push(
            '-f', 'hls',
            '-hls_time', String(hlsTime),
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'fmp4',
            '-hls_fmp4_init_filename', 'init.mp4',
            '-master_pl_name', 'master.m3u8',
        );

        const multiTrack = new Set(renditions.map(r => r.sourceTrackIndex ?? 0)).size > 1;

        const varParts: string[] = [];
        for (const { rendition, outputIndex } of videoIndexMap) {
            const name = this.buildVideoStreamName(rendition, multiTrack);
            let part = `v:${outputIndex},agroup:${rendition.audioGroupId},name:${name}`;
            varParts.push(part);
        }

        // Audio entries with group, name, and language
        const defaultedGroups = new Set<string>();
        for (const { group, outputIndex } of audioOutputs) {
            const name = (group.label ?? `${group.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
            let part = `a:${outputIndex},agroup:${group.id},name:${name}`;
            if (group.language) {
                part += `,language:${group.language}`;
            }
            const isDefault = !defaultedGroups.has(group.id);
            if (isDefault) defaultedGroups.add(group.id);
            part += `,default:${isDefault ? 'yes' : 'no'}`;
            varParts.push(part);
        }

        args.push('-var_stream_map', varParts.join(' '));

        args.push(
            '-hls_segment_filename',
            join(outputDir, 'stream_%v', 'segment_%05d.m4s'),
            join(outputDir, 'stream_%v', 'playlist.m3u8'),
        );

        return args;
    }

    private buildAudioArgs(opts: EncodeOptions): string[] {
        const { inputPath, outputDir, encodeConfig } = opts;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = opts.byteRange !== false ? 2 : (encodeConfig.segmentDuration ?? 6);
        const args: string[] = ['-i', inputPath];
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
                    args.push(`-q:a:${i}`, this.bitrateToVbrQuality(group.audioBitrateKbps));
                } else {
                    args.push(`-b:a:${i}`, `${group.audioBitrateKbps}k`);
                }
                const channels = (!group.vbr && group.audioBitrateKbps < 100) ? 1 : group.channels;
                args.push(`-ac:a:${i}`, `${channels}`);
            }
        });

        const varParts: string[] = [];
        for (let i = 0; i < audioGroups.length; i++) {
            const group = audioGroups[i];
            const name = (group.label ?? `${group.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
            varParts.push(`a:${i},name:${name}`);
        }

        args.push(
            '-f', 'hls',
            '-hls_time', String(segmentDuration),
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'fmp4',
            '-hls_fmp4_init_filename', 'init.mp4',
            '-master_pl_name', 'master.m3u8',
            '-var_stream_map', varParts.join(' '),
            '-hls_segment_filename',
            join(outputDir, 'stream_%v', 'segment_%05d.m4s'),
            join(outputDir, 'stream_%v', 'playlist.m3u8'),
        );

        return args;
    }

    private parseProgressTime(data: string): number | null {
        const usMatch = data.match(/out_time_us=(\d+)/);
        if (usMatch) {
            return parseInt(usMatch[1], 10) / 1_000_000;
        }

        const timeMatch = data.match(
            /out_time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/,
        );
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

        const totalDuration = this.probeDuration(opts.inputPath);
        const args =
            type === 'video'
                ? this.buildVideoArgs(opts)
                : this.buildAudioArgs(opts);

        this.logger.debug(`FFmpeg args: ffmpeg ${args.join(' ')}`);

        return new Promise<EncodeResult>((resolve, reject) => {
            const proc = spawn('ffmpeg', args, {
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
                                (currentTime / totalDuration) * 100,
                            );
                            if (percent - lastProgress >= 0.5) {
                                lastProgress = percent;
                                onProgress(
                                    Math.round(percent * 10) / 10,
                                );
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
                } else {
                    if (opts.byteRange !== false) {
                        const maxBytes = opts.byteRangeMaxFileSizeBytes
                            ?? 500 * 1024 * 1024;
                        this.convertToByteRange(outputDir, maxBytes);
                    }

                    let anglePlaylists: AnglePlaylist[] = [];
                    let masterPlaylistFilename = 'master.m3u8';
                    if (type === 'video') {
                        this.fixMasterPlaylist(outputDir, encodeConfig);
                        anglePlaylists = this.generateAnglePlaylists(outputDir, encodeConfig);
                        if (anglePlaylists.length > 1) {
                            const masterPath = join(outputDir, 'master.m3u8');
                            if (existsSync(masterPath)) {
                                unlinkSync(masterPath);
                            }
                            masterPlaylistFilename =
                                anglePlaylists[0]?.filename ?? 'master.m3u8';
                        }

                        const audioOnlyPlaylist = this.generateAudioOnlyPlaylist(outputDir, encodeConfig);
                        if (audioOnlyPlaylist) {
                            if (anglePlaylists.length === 1 && anglePlaylists[0].name === 'Default') {
                                anglePlaylists[0] = { ...anglePlaylists[0], name: 'Video' };
                            }
                            anglePlaylists.push(audioOnlyPlaylist);
                        }
                    }
                    resolve({
                        outputDir,
                        masterPlaylist: masterPlaylistFilename,
                        anglePlaylists,
                    });
                }
            };

            proc.on('error', (err) => {
                settle(
                    new Error(`FFmpeg spawn error: ${err.message}`),
                );
            });

            proc.on('close', (code, signal) => {
                if (code === 0) {
                    settle();
                } else {
                    const tail = stderrBuffer.slice(-2000);
                    settle(
                        new Error(
                            `FFmpeg exited with code ${code}${signal ? ` (signal: ${signal})` : ''}. stderr tail:\n${tail}`,
                        ),
                    );
                }
            });

            let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
            if (this.timeoutMs > 0) {
                timeoutTimer = setTimeout(() => {
                    if (!settled) {
                        this.logger.warn(
                            `FFmpeg timeout (${this.timeoutMs}ms) for session ${opts.sessionId}, killing process`,
                        );
                        proc.kill('SIGKILL');
                        settle(
                            new Error(
                                `FFmpeg timed out after ${this.timeoutMs}ms`,
                            ),
                        );
                    }
                }, this.timeoutMs);
            }
        });
    }

    private convertToByteRange(outputDir: string, maxFileSizeBytes: number): void {
        const entries = readdirSync(outputDir, { withFileTypes: true });
        const streamDirs = entries
            .filter(e => e.isDirectory() && e.name.startsWith('stream_'))
            .map(e => e.name)
            .sort();

        for (const dir of streamDirs) {
            this.convertStreamToByteRange(join(outputDir, dir), maxFileSizeBytes);
        }

        this.logger.log(
            `Byte-range conversion complete for ${streamDirs.length} stream(s) (max ${Math.round(maxFileSizeBytes / 1024 / 1024)} MB per file)`,
        );
    }

    private convertStreamToByteRange(streamDir: string, maxFileSizeBytes: number): void {
        const playlistPath = join(streamDir, 'playlist.m3u8');
        if (!existsSync(playlistPath)) return;

        const content = readFileSync(playlistPath, 'utf-8');
        const lines = content.split('\n');

        const headerLines: string[] = [];
        const segments: { extinfLine: string; filename: string }[] = [];
        let footerLine = '';
        let inSegments = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXTINF:')) {
                inSegments = true;
                const filename = lines[i + 1]?.trim();
                if (filename && !filename.startsWith('#')) {
                    segments.push({ extinfLine: line, filename });
                    i++;
                }
            } else if (line.startsWith('#EXT-X-ENDLIST')) {
                footerLine = line;
            } else if (!inSegments) {
                headerLines.push(line);
            }
        }

        if (segments.length === 0) return;

        const byteRanges: { extinfLine: string; length: number; offset: number; mediaFile: string }[] = [];
        let fileIndex = 0;
        let currentOffset = 0;
        let currentMediaFile = `media_${fileIndex}.m4s`;
        let fd = openSync(join(streamDir, currentMediaFile), 'w');

        for (const seg of segments) {
            const segPath = join(streamDir, seg.filename);
            if (!existsSync(segPath)) continue;

            const segData = readFileSync(segPath);
            const segSize = segData.length;

            if (currentOffset > 0 && currentOffset + segSize > maxFileSizeBytes) {
                closeSync(fd);
                fileIndex++;
                currentOffset = 0;
                currentMediaFile = `media_${fileIndex}.m4s`;
                fd = openSync(join(streamDir, currentMediaFile), 'w');
            }

            writeSync(fd, segData);
            byteRanges.push({
                extinfLine: seg.extinfLine,
                length: segSize,
                offset: currentOffset,
                mediaFile: currentMediaFile,
            });
            currentOffset += segSize;
        }

        closeSync(fd);

        const newLines: string[] = [...headerLines];
        for (const br of byteRanges) {
            newLines.push(br.extinfLine);
            newLines.push(`#EXT-X-BYTERANGE:${br.length}@${br.offset}`);
            newLines.push(br.mediaFile);
        }
        if (footerLine) newLines.push(footerLine);
        newLines.push('');

        writeFileSync(playlistPath, newLines.join('\n'), 'utf-8');

        for (const seg of segments) {
            const segPath = join(streamDir, seg.filename);
            if (existsSync(segPath)) unlinkSync(segPath);
        }
    }

    private fixMasterPlaylist(
        outputDir: string,
        config: EncodeConfigDto,
    ): void {
        const masterPath = join(outputDir, 'master.m3u8');
        if (!existsSync(masterPath)) return;

        let content = readFileSync(masterPath, 'utf-8');
        content = this.fixMasterPlaylistAudioNames(content, config);
        content = this.fixMasterPlaylistVideoGroups(content, config);
        writeFileSync(masterPath, content, 'utf-8');
    }

    private fixMasterPlaylistAudioNames(
        content: string,
        config: EncodeConfigDto,
    ): string {
        const audioGroups = config.audioGroups ?? [];
        if (audioGroups.length === 0) return content;

        const nameByUri = new Map<string, string>();
        for (const group of audioGroups) {
            const streamName = (group.label ?? `${group.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
            const uri = `stream_${streamName}/playlist.m3u8`;
            nameByUri.set(uri, group.label ?? group.language ?? 'Audio');
        }

        return content.split('\n').map((line) => {
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
        }).join('\n');
    }

    /**
     * Parse the already-fixed master.m3u8 (which has VIDEO="angle" attributes)
     * and split it into one playlist per angle. Does NOT upload the original
     * multi-angle master because most HLS web players don't support it.
     */
    private generateAnglePlaylists(
        outputDir: string,
        config: EncodeConfigDto,
    ): AnglePlaylist[] {
        const renditions = config.videoRenditions ?? [];
        if (renditions.length === 0) return [];

        const masterPath = join(outputDir, 'master.m3u8');
        if (!existsSync(masterPath)) return [];

        const uniqueTracks = new Set(renditions.map(r => r.sourceTrackIndex ?? 0));
        if (uniqueTracks.size <= 1) {
            return [{ name: 'Default', filename: 'master.m3u8' }];
        }

        const content = readFileSync(masterPath, 'utf-8');
        const lines = content.split('\n');

        let extVersion = '#EXT-X-VERSION:3';
        const audioMediaLines: string[] = [];
        const streamsByAngle = new Map<string, { infLine: string; uri: string }[]>();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXT-X-VERSION:')) {
                extVersion = line;
            } else if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
                audioMediaLines.push(line);
            } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const uriLine = lines[i + 1]?.trim();
                if (!uriLine || uriLine.startsWith('#')) continue;

                const videoMatch = line.match(/VIDEO="([^"]+)"/);
                const angleId = videoMatch?.[1] ?? 'default';

                if (!streamsByAngle.has(angleId)) {
                    streamsByAngle.set(angleId, []);
                }

                const cleanedLine = line.replace(/,?VIDEO="[^"]*"/g, '');
                streamsByAngle.get(angleId)!.push({ infLine: cleanedLine, uri: uriLine });
            }
        }

        this.logger.debug(
            `generateAnglePlaylists: found ${streamsByAngle.size} angle(s) in master.m3u8: ` +
            `${[...streamsByAngle.entries()].map(([k, v]) => `"${k}" (${v.length} streams)`).join(', ')}`,
        );

        const nameByTrackIndex = new Map<number, string>();
        for (const tn of config.videoTrackNames ?? []) {
            nameByTrackIndex.set(tn.index, tn.name ?? `Angle ${tn.index}`);
        }

        const sanitize = (s: string): string =>
            s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'angle';

        const anglePlaylists: AnglePlaylist[] = [];

        for (const [angleId, streams] of streamsByAngle) {
            const angleName = [...nameByTrackIndex.values()].find(
                name => sanitize(name) === angleId,
            ) ?? angleId;

            const filename = `${angleId}.m3u8`;
            const parts: string[] = ['#EXTM3U', extVersion, ...audioMediaLines];

            for (const { infLine, uri } of streams) {
                parts.push(infLine, uri);
            }

            const anglePath = join(outputDir, filename);
            writeFileSync(anglePath, parts.join('\n') + '\n', 'utf-8');
            anglePlaylists.push({ name: angleName, filename });

            this.logger.debug(
                `generateAnglePlaylists: wrote "${filename}" for angle "${angleName}" with ${streams.length} stream(s)`,
            );
        }

        return anglePlaylists;
    }

    /**
     * Generate a standalone audio-only master playlist from a video encode's
     * audio streams. Follows the same structure as audio-file-upload playlists.
     */
    private generateAudioOnlyPlaylist(
        outputDir: string,
        config: EncodeConfigDto,
    ): AnglePlaylist | null {
        const audioGroups = config.audioGroups ?? [];
        if (audioGroups.length === 0) return null;

        const masterPath = join(outputDir, 'master.m3u8');
        let extVersion = '#EXT-X-VERSION:7';
        if (existsSync(masterPath)) {
            const versionMatch = readFileSync(masterPath, 'utf-8').match(/#EXT-X-VERSION:\d+/);
            if (versionMatch) extVersion = versionMatch[0];
        }

        const parts: string[] = ['#EXTM3U', extVersion];

        let isFirst = true;
        for (const group of audioGroups) {
            const streamName = (group.label ?? `${group.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
            const uri = `stream_${streamName}/playlist.m3u8`;
            const name = group.label ?? group.language ?? 'Audio';
            const lang = group.language ? `,LANGUAGE="${group.language}"` : '';

            parts.push(
                `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="${name}",DEFAULT=${isFirst ? 'YES' : 'NO'}${lang},URI="${uri}"`,
            );
            isFirst = false;
        }

        const firstGroup = audioGroups[0];
        const firstName = (firstGroup.label ?? `${firstGroup.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
        const bandwidth = firstGroup.audioBitrateKbps * 1000;
        parts.push(
            '',
            `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="mp4a.40.2",AUDIO="audio"`,
            `stream_${firstName}/playlist.m3u8`,
        );

        const filename = 'audio_only.m3u8';
        writeFileSync(join(outputDir, filename), parts.join('\n') + '\n', 'utf-8');

        this.logger.debug(
            `generateAudioOnlyPlaylist: wrote "${filename}" with ${audioGroups.length} audio group(s)`,
        );

        return { name: 'Audio only', filename };
    }

    /**
     * Add VIDEO attribute to each EXT-X-STREAM-INF identifying the angle.
     * Uses positional matching (re-encode first, then copy) and derives the
     * angle name from videoTrackNames + sourceTrackIndex.
     */
    private fixMasterPlaylistVideoGroups(
        content: string,
        config: EncodeConfigDto,
    ): string {
        const renditions = config.videoRenditions ?? [];
        if (renditions.length === 0) return content;

        const uniqueTracks = new Set(renditions.map(r => r.sourceTrackIndex ?? 0));
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
            s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') || 'angle';

        const orderedRenditions = [
            ...renditions.filter(r => !r.copyStream),
            ...renditions.filter(r => r.copyStream),
        ];

        const lines = content.split('\n');
        const result: string[] = [];
        let videoEntryIndex = 0;
        let insertedVideoMedia = false;
        const insertedGroupIds = new Set<string>();

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (!insertedVideoMedia && (line.startsWith('#EXT-X-MEDIA:') || line.startsWith('#EXT-X-STREAM-INF:'))) {
                for (const [, angleName] of nameByTrackIndex) {
                    const groupId = sanitize(angleName);
                    if (insertedGroupIds.has(groupId)) continue;
                    insertedGroupIds.add(groupId);
                    const isDefault = insertedGroupIds.size === 1;
                    result.push(`#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="${groupId}",NAME="${angleName}",DEFAULT=${isDefault ? 'YES' : 'NO'}`);
                }
                insertedVideoMedia = true;
            }

            if (line.startsWith('#EXT-X-STREAM-INF:') && videoEntryIndex < orderedRenditions.length) {
                const rendition = orderedRenditions[videoEntryIndex];
                const angleName = nameByTrackIndex.get(rendition.sourceTrackIndex ?? 0) ?? 'Angle 0';
                const groupId = sanitize(angleName);
                const newLine = line.includes('AUDIO=')
                    ? line.replace(/AUDIO="([^"]+)"/, `VIDEO="${groupId}",AUDIO="$1"`)
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
        multiTrack: boolean,
    ): string {
        const base = (rendition.label ?? `${rendition.height}p`).replace(/\s+/g, '_');
        if (multiTrack) {
            return `${base}_t${rendition.sourceTrackIndex ?? 0}_${rendition.width}x${rendition.height}`;
        }
        return `${base}_${rendition.width}x${rendition.height}`;
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
