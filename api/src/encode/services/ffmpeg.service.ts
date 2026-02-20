import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { EncodeConfigDto, VideoRenditionDto, AudioGroupDto, AudioRenditionDto } from '../dto/encode-config.dto.js';
import dotenv from 'dotenv';

dotenv.config();

export interface EncodeOptions {
    sessionId: string;
    inputPath: string;
    outputDir: string;
    encodeConfig: EncodeConfigDto;
    onProgress: (percent: number) => void;
}

export interface EncodeResult {
    outputDir: string;
    masterPlaylist: string;
}

@Injectable()
export class FfmpegService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FfmpegService.name);
    private gpuAvailable = false;
    private activeProcess: ChildProcess | null = null;
    private readonly timeoutMs = process.env.FFMPEG_TIMEOUT_MS
        ? parseInt(process.env.FFMPEG_TIMEOUT_MS, 10)
        : 0;

    async onModuleInit(): Promise<void> {
        this.gpuAvailable = this.detectNvidiaGpu();
        if (this.gpuAvailable) {
            this.logger.log(
                'NVIDIA GPU detected, using NVENC acceleration',
            );
        } else {
            this.logger.log('No NVIDIA GPU found, using CPU encoding');
        }
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

    private buildVideoArgs(opts: EncodeOptions): string[] {
        const { inputPath, outputDir, encodeConfig } = opts;
        const renditions = encodeConfig.videoRenditions!;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const args: string[] = [];

        const hasReencode = renditions.some(r => !r.copyStream);

        if (hasReencode && this.gpuAvailable) {
            args.push('-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda');
        }
        args.push('-i', inputPath);
        args.push('-progress', 'pipe:2', '-stats_period', '1');

        const reencodeRenditions = renditions.filter(r => !r.copyStream);
        const copyRenditions = renditions.filter(r => r.copyStream);

        // Build filter_complex for re-encoded streams only
        if (reencodeRenditions.length > 0) {
            const filterParts: string[] = [];
            const splitOutputs = reencodeRenditions.map((_, i) => `[reencode${i}]`).join('');
            filterParts.push(`[0:v:0]split=${reencodeRenditions.length}${splitOutputs}`);
            reencodeRenditions.forEach((r, i) => {
                const scaler = this.gpuAvailable ? 'scale_cuda' : 'scale';
                filterParts.push(`[reencode${i}]${scaler}=${r.width}:${r.height}[vout${i}]`);
            });
            args.push('-filter_complex', filterParts.join(';'));
        }

        // Map video streams: re-encoded first, then copy
        let videoOutputIndex = 0;
        const videoIndexMap: { rendition: VideoRenditionDto; outputIndex: number }[] = [];

        for (let i = 0; i < reencodeRenditions.length; i++) {
            const r = reencodeRenditions[i];
            args.push('-map', `[vout${i}]`);

            if (this.gpuAvailable) {
                args.push(
                    `-c:v:${videoOutputIndex}`, 'h264_nvenc',
                    `-preset:v:${videoOutputIndex}`, this.getNvencPreset(r.height),
                    `-tune:v:${videoOutputIndex}`, 'hq',
                    `-rc:v:${videoOutputIndex}`, 'vbr',
                    `-b:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                    `-maxrate:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.07)}k`,
                    `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.5)}k`,
                );
            } else {
                args.push(
                    `-c:v:${videoOutputIndex}`, 'libx264',
                    `-preset:v:${videoOutputIndex}`, this.getX264Preset(r.height),
                    `-b:v:${videoOutputIndex}`, `${r.videoBitrateKbps}k`,
                    `-maxrate:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.07)}k`,
                    `-bufsize:v:${videoOutputIndex}`, `${Math.round(r.videoBitrateKbps * 1.5)}k`,
                );
            }
            args.push(
                `-g:v:${videoOutputIndex}`, `${segmentDuration * 30}`,
                `-keyint_min:v:${videoOutputIndex}`, `${segmentDuration * 30}`,
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
                const codec = group.audioCodec === 'mp3' ? 'libmp3lame' : 'aac';
                args.push(
                    `-c:a:${audioOutputIndex}`, codec,
                    `-b:a:${audioOutputIndex}`, `${group.audioBitrateKbps}k`,
                    `-ac:a:${audioOutputIndex}`, `${group.channels}`,
                );
            }
            audioOutputs.push({ group, outputIndex: audioOutputIndex });
            audioOutputIndex++;
        }

        // HLS output options
        args.push(
            '-f', 'hls',
            '-hls_time', String(segmentDuration),
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'mpegts',
            '-master_pl_name', 'master.m3u8',
        );

        // Build var_stream_map with audio groups
        const varParts: string[] = [];

        // Video entries referencing audio groups
        for (const { rendition, outputIndex } of videoIndexMap) {
            const name = (rendition.label ?? `${rendition.height}p`).replace(/\s+/g, '_');
            let part = `v:${outputIndex},agroup:${rendition.audioGroupId},name:${name}`;
            varParts.push(part);
        }

        // Audio entries with group, name, and language
        for (const { group, outputIndex } of audioOutputs) {
            const name = (group.label ?? `${group.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
            let part = `a:${outputIndex},agroup:${group.id},name:${name}`;
            if (group.language) {
                part += `,language:${group.language}`;
            }
            part += `,default:${outputIndex === 0 ? 'yes' : 'no'}`;
            varParts.push(part);
        }

        args.push('-var_stream_map', varParts.join(' '));

        args.push(
            '-hls_segment_filename',
            join(outputDir, 'stream_%v', 'segment_%03d.ts'),
            join(outputDir, 'stream_%v', 'playlist.m3u8'),
        );

        return args;
    }

    private buildAudioArgs(opts: EncodeOptions): string[] {
        const { inputPath, outputDir, encodeConfig } = opts;
        const renditions = encodeConfig.audioRenditions!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const args: string[] = ['-i', inputPath];

        args.push('-progress', 'pipe:2', '-stats_period', '1');
        args.push('-vn');

        if (renditions.length === 1) {
            const r = renditions[0];
            if (r.copyStream) {
                args.push(
                    '-map', `0:a:${r.sourceTrackIndex}`,
                    '-c:a', 'copy',
                );
            } else {
                const codec = r.audioCodec === 'mp3' ? 'libmp3lame' : 'aac';
                args.push(
                    '-map', `0:a:${r.sourceTrackIndex}`,
                    '-c:a', codec,
                    '-b:a', `${r.audioBitrateKbps}k`,
                    '-ac', `${r.channels}`,
                );
            }
            args.push(
                '-f', 'hls',
                '-hls_time', String(segmentDuration),
                '-hls_playlist_type', 'vod',
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename',
                join(outputDir, 'a0', 'segment_%03d.ts'),
                join(outputDir, 'a0', 'playlist.m3u8'),
            );
        } else {
            renditions.forEach((r, i) => {
                args.push('-map', `0:a:${r.sourceTrackIndex}`);
                if (r.copyStream) {
                    args.push(`-c:a:${i}`, 'copy');
                } else {
                    const codec = r.audioCodec === 'mp3' ? 'libmp3lame' : 'aac';
                    args.push(
                        `-c:a:${i}`, codec,
                        `-b:a:${i}`, `${r.audioBitrateKbps}k`,
                        `-ac:a:${i}`, `${r.channels}`,
                    );
                }
            });

            const varParts = renditions.map((r, i) => {
                const name = (r.label ?? `${r.audioBitrateKbps}kbps`).replace(/\s+/g, '_');
                let part = `a:${i},name:${name}`;
                if (r.language) part += `,language:${r.language}`;
                if (i === 0) part += ',default:yes';
                return part;
            });

            args.push(
                '-f', 'hls',
                '-hls_time', String(segmentDuration),
                '-hls_playlist_type', 'vod',
                '-hls_flags', 'independent_segments',
                '-hls_segment_type', 'mpegts',
                '-master_pl_name', 'master.m3u8',
                '-var_stream_map', varParts.join(' '),
                '-hls_segment_filename',
                join(outputDir, 'a%v', 'segment_%03d.ts'),
                join(outputDir, 'a%v', 'playlist.m3u8'),
            );
        }

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
            const numRenditions = encodeConfig.audioRenditions?.length ?? 1;
            if (numRenditions === 1) {
                const dir = join(outputDir, 'a0');
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            } else {
                for (let i = 0; i < numRenditions; i++) {
                    const dir = join(outputDir, `a${i}`);
                    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
                }
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
                    if (type === 'video') {
                        this.fixMasterPlaylistAudioNames(outputDir, encodeConfig);
                    }
                    resolve({
                        outputDir,
                        masterPlaylist: 'master.m3u8',
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

    private fixMasterPlaylistAudioNames(
        outputDir: string,
        config: EncodeConfigDto,
    ): void {
        const masterPath = join(outputDir, 'master.m3u8');
        if (!existsSync(masterPath)) return;

        const audioGroups = config.audioGroups ?? [];
        if (audioGroups.length === 0) return;

        const trackNameBySource = new Map<number, string>();
        for (const group of audioGroups) {
            if (!trackNameBySource.has(group.sourceTrackIndex)) {
                trackNameBySource.set(
                    group.sourceTrackIndex,
                    group.language ?? 'Audio',
                );
            }
        }

        const nameByGroupId = new Map<string, string>();
        for (const group of audioGroups) {
            const trackName = trackNameBySource.get(group.sourceTrackIndex)!;
            nameByGroupId.set(group.id, trackName);
            nameByGroupId.set(`group_${group.id}`, trackName);
        }

        const content = readFileSync(masterPath, 'utf-8');
        const lines = content.split('\n').map((line) => {
            if (
                !line.startsWith('#EXT-X-MEDIA:') ||
                !line.includes('TYPE=AUDIO')
            ) {
                return line;
            }
            const groupIdMatch = line.match(/GROUP-ID="([^"]+)"/);
            if (!groupIdMatch) return line;

            const name = nameByGroupId.get(groupIdMatch[1]);
            if (!name) return line;
            return line.replace(/NAME="[^"]*"/, `NAME="${name}"`);
        });

        writeFileSync(masterPath, lines.join('\n'), 'utf-8');
    }

    isGpuAvailable(): boolean {
        return this.gpuAvailable;
    }
}
