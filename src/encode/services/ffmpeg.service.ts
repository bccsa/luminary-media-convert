import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { spawn, execSync, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import type { RenditionDto } from '../dto/rendition.dto.js';
import dotenv from 'dotenv';

dotenv.config();

export interface EncodeOptions {
    sessionId: string;
    inputPath: string;
    outputDir: string;
    type: 'video' | 'audio';
    renditions: RenditionDto[];
    segmentDuration: number;
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
                'NVIDIA GPU detected, using NVENC acceleration'
            );
        } else {
            this.logger.log('No NVIDIA GPU found, using CPU encoding');
        }
    }

    async onModuleDestroy(): Promise<void> {
        if (this.activeProcess && !this.activeProcess.killed) {
            this.logger.log(
                'Shutting down: killing active FFmpeg process...'
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

    /**
     * Probe the input file duration in seconds using ffprobe.
     */
    private probeDuration(inputPath: string): number {
        try {
            const output = execSync(
                `ffprobe -v error -show_entries format=duration -of csv=p=0 "${inputPath}"`,
                { encoding: 'utf-8', timeout: 30000 }
            );
            const duration = parseFloat(output.trim());
            return isNaN(duration) ? 0 : duration;
        } catch {
            this.logger.warn('Could not probe input duration, progress will be unavailable');
            return 0;
        }
    }

    /**
     * Build FFmpeg arguments for video HLS ABR encoding.
     */
    private buildVideoArgs(opts: EncodeOptions): string[] {
        const { inputPath, outputDir, renditions, segmentDuration } = opts;
        const args: string[] = [];

        // Input with hardware acceleration if available
        if (this.gpuAvailable) {
            args.push(
                '-hwaccel', 'cuda',
                '-hwaccel_output_format', 'cuda'
            );
        }
        args.push('-i', inputPath);

        // Progress output
        args.push('-progress', 'pipe:2', '-stats_period', '1');

        const numRenditions = renditions.length;

        if (this.gpuAvailable) {
            // GPU pipeline: use scale_cuda
            const filterParts: string[] = [];
            const splitOutputs = renditions
                .map((_, i) => `[v${i}]`)
                .join('');
            filterParts.push(
                `[0:v]split=${numRenditions}${splitOutputs}`
            );
            renditions.forEach((r, i) => {
                const w = r.width ?? -2;
                const h = r.height ?? -2;
                filterParts.push(
                    `[v${i}]scale_cuda=${w}:${h}[v${i}out]`
                );
            });
            args.push('-filter_complex', filterParts.join(';'));
        } else {
            // CPU pipeline: use regular scale
            const filterParts: string[] = [];
            const splitOutputs = renditions
                .map((_, i) => `[v${i}]`)
                .join('');
            filterParts.push(
                `[0:v]split=${numRenditions}${splitOutputs}`
            );
            renditions.forEach((r, i) => {
                const w = r.width ?? -2;
                const h = r.height ?? -2;
                filterParts.push(
                    `[v${i}]scale=${w}:${h}[v${i}out]`
                );
            });
            args.push('-filter_complex', filterParts.join(';'));
        }

        // Map each rendition's video and audio
        renditions.forEach((r, i) => {
            args.push('-map', `[v${i}out]`);

            if (this.gpuAvailable) {
                args.push(
                    `-c:v:${i}`, 'h264_nvenc',
                    `-preset:v:${i}`, 'p4',
                    `-tune:v:${i}`, 'hq',
                    `-rc:v:${i}`, 'vbr',
                    `-b:v:${i}`, `${r.videoBitrateKbps ?? 2500}k`,
                    `-maxrate:v:${i}`, `${Math.round((r.videoBitrateKbps ?? 2500) * 1.07)}k`,
                    `-bufsize:v:${i}`, `${Math.round((r.videoBitrateKbps ?? 2500) * 1.5)}k`
                );
            } else {
                args.push(
                    `-c:v:${i}`, 'libx264',
                    `-preset:v:${i}`, 'veryfast',
                    `-tune:v:${i}`, 'zerolatency',
                    `-b:v:${i}`, `${r.videoBitrateKbps ?? 2500}k`,
                    `-maxrate:v:${i}`, `${Math.round((r.videoBitrateKbps ?? 2500) * 1.07)}k`,
                    `-bufsize:v:${i}`, `${Math.round((r.videoBitrateKbps ?? 2500) * 1.5)}k`
                );
            }

            args.push(`-g:v:${i}`, `${segmentDuration * 30}`);
            args.push(`-keyint_min:v:${i}`, `${segmentDuration * 30}`);
        });

        // Map audio once for all variants
        renditions.forEach((_, i) => {
            args.push('-map', '0:a:0');
        });

        renditions.forEach((r, i) => {
            const codec = r.audioCodec === 'mp3' ? 'libmp3lame' : 'aac';
            args.push(
                `-c:a:${i}`, codec,
                `-b:a:${i}`, `${r.audioBitrateKbps}k`
            );
        });

        // HLS output
        args.push(
            '-f', 'hls',
            '-hls_time', String(segmentDuration),
            '-hls_playlist_type', 'vod',
            '-hls_flags', 'independent_segments',
            '-hls_segment_type', 'mpegts',
            '-master_pl_name', 'master.m3u8'
        );

        // var_stream_map
        const varStreamMap = renditions
            .map((_, i) => `v:${i},a:${i}`)
            .join(' ');
        args.push('-var_stream_map', varStreamMap);

        args.push(
            '-hls_segment_filename',
            join(outputDir, 'v%v', 'segment_%03d.ts'),
            join(outputDir, 'v%v', 'playlist.m3u8')
        );

        return args;
    }

    /**
     * Build FFmpeg arguments for audio-only HLS encoding.
     */
    private buildAudioArgs(opts: EncodeOptions): string[] {
        const { inputPath, outputDir, renditions, segmentDuration } = opts;
        const args: string[] = ['-i', inputPath];

        args.push('-progress', 'pipe:2', '-stats_period', '1');
        args.push('-vn');

        if (renditions.length === 1) {
            const r = renditions[0];
            const codec = r.audioCodec === 'mp3' ? 'libmp3lame' : 'aac';
            args.push(
                '-map', '0:a:0',
                '-c:a', codec,
                '-b:a', `${r.audioBitrateKbps}k`,
                '-f', 'hls',
                '-hls_time', String(segmentDuration),
                '-hls_playlist_type', 'vod',
                '-hls_segment_type', 'mpegts',
                '-hls_segment_filename',
                join(outputDir, 'a0', 'segment_%03d.ts'),
                join(outputDir, 'a0', 'playlist.m3u8')
            );
        } else {
            // Multi-bitrate audio
            renditions.forEach((r, i) => {
                args.push('-map', '0:a:0');
                const codec = r.audioCodec === 'mp3' ? 'libmp3lame' : 'aac';
                args.push(
                    `-c:a:${i}`, codec,
                    `-b:a:${i}`, `${r.audioBitrateKbps}k`
                );
            });

            const varStreamMap = renditions
                .map((_, i) => `a:${i}`)
                .join(' ');

            args.push(
                '-f', 'hls',
                '-hls_time', String(segmentDuration),
                '-hls_playlist_type', 'vod',
                '-hls_flags', 'independent_segments',
                '-hls_segment_type', 'mpegts',
                '-master_pl_name', 'master.m3u8',
                '-var_stream_map', varStreamMap,
                '-hls_segment_filename',
                join(outputDir, 'a%v', 'segment_%03d.ts'),
                join(outputDir, 'a%v', 'playlist.m3u8')
            );
        }

        return args;
    }

    /**
     * Parse progress from FFmpeg's -progress pipe:2 output.
     * Returns the current time in seconds, or null if not parseable.
     */
    private parseProgressTime(data: string): number | null {
        // FFmpeg progress output: out_time_us=MICROSECONDS or out_time=HH:MM:SS.FFFFFF
        const usMatch = data.match(/out_time_us=(\d+)/);
        if (usMatch) {
            return parseInt(usMatch[1], 10) / 1_000_000;
        }

        const timeMatch = data.match(
            /out_time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/
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

    /**
     * Run the FFmpeg encoding process. Returns a promise that resolves when encoding is complete.
     * The onProgress callback receives percent values (0-100).
     */
    async encode(opts: EncodeOptions): Promise<EncodeResult> {
        const { outputDir, renditions, type, onProgress } = opts;

        // Ensure output subdirectories exist
        if (!existsSync(outputDir)) {
            mkdirSync(outputDir, { recursive: true });
        }
        if (type === 'video') {
            renditions.forEach((_, i) => {
                const dir = join(outputDir, `v${i}`);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            });
        } else {
            renditions.forEach((_, i) => {
                const dir = join(outputDir, `a${i}`);
                if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            });
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

                    // Keep only last 8KB of stderr for error reporting
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
                                onProgress(
                                    Math.round(percent * 10) / 10
                                );
                            }
                        }
                    }
                } catch {
                    // Never let stderr parsing crash the process
                }
            });

            // Drain stdout to prevent backpressure
            proc.stdout?.resume();

            let settled = false;
            const settle = (err?: Error) => {
                if (settled) return;
                settled = true;
                this.activeProcess = null;
                if (timeoutTimer) clearTimeout(timeoutTimer);
                if (err) reject(err);
                else
                    resolve({
                        outputDir,
                        masterPlaylist: 'master.m3u8',
                    });
            };

            proc.on('error', (err) => {
                settle(
                    new Error(`FFmpeg spawn error: ${err.message}`)
                );
            });

            proc.on('close', (code, signal) => {
                if (code === 0) {
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

            // Optional timeout
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

    isGpuAvailable(): boolean {
        return this.gpuAvailable;
    }
}
