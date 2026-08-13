import {
    Injectable,
    Logger,
    OnModuleInit,
    OnModuleDestroy,
} from '@nestjs/common';
import { spawn, execFile, execSync, type ChildProcess } from 'child_process';
import { mkdirSync, existsSync } from 'fs';
import { readFile, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { promisify } from 'util';
import type {
    EncodeConfigDto,
    VideoRenditionDto,
    AudioGroupDto,
    TrimSegmentDto,
} from '../dto/encode-config.dto.js';
import dotenv from 'dotenv';
import { ffmpegBin, ffmpegShellBin, ffprobeBin } from './ffbin.js';
import { checkFfmpeg } from './ffmpeg-availability.js';
import { ALIGNMENT_TOLERANCE_SECONDS } from './copy-mode-eligibility.js';

const execFileAsync = promisify(execFile);

dotenv.config();

export interface EncodeOptions {
    sessionId: string;
    inputPath: string;
    outputDir: string;
    encodeConfig: EncodeConfigDto;
    onProgress: (percent: number) => void;
}

/**
 * The container the output's segments arrive in.
 *
 * New encodes are always `'fmp4'` — a source whose streams do not start
 * together is aligned with an input seek rather than escaped into MPEG-TS, so
 * the output's container is no longer a property of the input. `'mpegts'`
 * survives in the union for one reason: a `session.json` written before that
 * change is still restored at boot, and a restored session has to report what
 * it actually produced.
 */
export type SegmentFormat = 'fmp4' | 'mpegts';

export interface EncodeResult {
    outputDir: string;
    masterPlaylist: string;
    segmentFormat: SegmentFormat;
}

export type AccelMode = 'cpu' | 'nvidia' | 'apple' | 'intel';

@Injectable()
export class FfmpegService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(FfmpegService.name);
    private accelMode: AccelMode = 'cpu';
    /**
     * Why FFmpeg cannot be used here, or null when it can. Set once by
     * {@link onModuleInit}; null before it runs, which is before Nest serves
     * anything.
     */
    private unusableReason: string | null = null;
    private activeProcess: ChildProcess | null = null;
    private readonly timeoutMs = process.env.FFMPEG_TIMEOUT_MS
        ? parseInt(process.env.FFMPEG_TIMEOUT_MS, 10)
        : 0;
    private readonly threads = process.env.FFMPEG_THREADS
        ? parseInt(process.env.FFMPEG_THREADS, 10)
        : 8;

    async onModuleInit(): Promise<void> {
        /*
         * Is there a usable FFmpeg at all — is it installed, and is it new
         * enough? Asked before the acceleration probes below, which answer a
         * different question and used to be the only question asked: each wraps
         * `execSync` in `try/catch` and falls through to 'cpu', so a machine with
         * no ffmpeg whatsoever reported "No GPU found, using CPU encoding" and
         * said nothing more until the first encode, several user decisions later.
         */
        const { availability, reason, detail } = await checkFfmpeg();
        this.unusableReason = reason;
        if (reason) {
            this.logger.error(reason);
            // Which options were missing, for us rather than for the user —
            // "too old" alone is not diagnosable when a build fails this
            // check unexpectedly.
            if (detail) this.logger.error(detail);
            // The probes below would only spawn an absent or too-old binary
            // several more times to reach the same conclusion.
            this.accelMode = 'cpu';
            return;
        }

        this.logger.log(
            `FFmpeg ${availability.ffmpeg.version ?? '(unknown version)'}, ` +
                `ffprobe ${availability.ffprobe.version ?? '(unknown version)'}`
        );

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
            case 'intel':
                this.logger.log(
                    'Intel Quick Sync detected, using QSV acceleration'
                );
                break;
            default:
                this.logger.log('No GPU found, using CPU encoding');
        }
        this.logger.log(`FFmpeg threads: ${this.threads}`);
    }

    /**
     * Why this machine cannot encode, or null when it can.
     *
     * Read by the endpoints that would otherwise spawn ffmpeg or ffprobe, so a
     * missing or too-old install is refused with something actionable instead of
     * surfacing as an `ENOENT`, or as a mid-encode failure on an unrecognised
     * option, partway through a session.
     *
     * Decided once at startup rather than per request: the probes spawn several
     * processes, and an install does not change under a running app often enough
     * to pay that on every call.
     */
    unavailableReason(): string | null {
        return this.unusableReason;
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
        // Ordered by how fast the hardware is, not by how likely it is to be
        // present: a machine with a discrete NVIDIA card and an Intel iGPU has
        // both, and NVENC is the better of the two.
        if (this.detectNvidiaGpu()) return 'nvidia';
        if (this.detectAppleGpu()) return 'apple';
        if (this.detectIntelQsv()) return 'intel';
        return 'cpu';
    }

    /**
     * Quick Sync, through the oneVPL dispatcher the Windows build links.
     *
     * Windows only: the encoder ships `h264_qsv` there and nowhere else, and on a
     * Mac an Intel iGPU is reached through VideoToolbox instead.
     *
     * Asked of the binary rather than of the machine — there is no `nvidia-smi`
     * equivalent worth shelling out to, and the dispatcher answers the same
     * question by refusing to initialise. All three capabilities are required:
     * the hwaccel to decode onto the GPU, the encoder to write from it, and
     * `vpp_qsv` to scale in between. A build with the encoder but no scaler would
     * pick this path and then fail on every ladder.
     */
    private detectIntelQsv(): boolean {
        if (process.platform !== 'win32') return false;
        try {
            const hwaccels = execSync(
                `${ffmpegShellBin()} -hwaccels 2>/dev/null`,
                { encoding: 'utf-8', timeout: 5000 }
            );
            if (!hwaccels.includes('qsv')) return false;

            const encoders = execSync(
                `${ffmpegShellBin()} -encoders 2>/dev/null`,
                { encoding: 'utf-8', timeout: 5000 }
            );
            if (!encoders.includes('h264_qsv')) return false;

            const filters = execSync(
                `${ffmpegShellBin()} -filters 2>/dev/null`,
                { encoding: 'utf-8', timeout: 5000 }
            );
            return filters.includes('vpp_qsv');
        } catch {
            return false;
        }
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
     * How far into the source every stream has to be seeked for them all to
     * begin together — 0 when they already do.
     *
     * A container whose audio starts a tenth of a second after its video used
     * to be encoded to MPEG-TS instead of fMP4, on the reasoning that hls.js
     * resynchronises PTS while transmuxing TS and appends fMP4 as it finds it.
     * That made the output's container format a property of whatever file the
     * user happened to hand over, and left the format every other player
     * prefers unavailable to exactly the sources that most needed a well-formed
     * one.
     *
     * Aligning at the input instead costs the head of the programme — at most
     * the spread, typically tens of milliseconds — and settles the question
     * before a single frame is encoded. Only the streams the config actually
     * maps are considered: a track nobody asked for cannot drag the whole
     * encode forward.
     *
     * A probe that came back with nothing returns 0. Refusing to encode over a
     * question ffprobe would not answer is worse than encoding as we always
     * did.
     */
    private async computeAlignmentOffset(
        inputPath: string,
        encodeConfig: EncodeConfigDto
    ): Promise<number> {
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

        if (usedStartTimes.length < 2) return 0;

        const maxStart = Math.max(...usedStartTimes);
        const minStart = Math.min(...usedStartTimes);
        const spread = maxStart - minStart;

        if (spread < ALIGNMENT_TOLERANCE_SECONDS) {
            this.logger.log(
                `Stream start times aligned (spread ${(spread * 1000).toFixed(0)}ms)`
            );
            return 0;
        }

        this.logger.log(
            `Stream start times differ by ${(spread * 1000).toFixed(0)}ms ` +
                `(min ${minStart.toFixed(3)}s, max ${maxStart.toFixed(3)}s) — ` +
                `aligning all streams to ${maxStart}s with an input seek`
        );
        return maxStart;
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

    private async buildConcatFile(
        inputPath: string,
        segments: TrimSegmentDto[],
        outputDir: string,
        alignmentOffset = 0
    ): Promise<string> {
        const lines = ['ffconcat version 1.0'];
        /*
         * Absolute, because the concat demuxer resolves relative entries against
         * the *list file's own directory* — not this process's working directory.
         * A relative source would be looked for inside `outputDir` and the trim
         * would fail on a file that is plainly there.
         *
         * The controller already rejects a non-absolute source at ingest, so this
         * is belt and braces — but the sprite packer had exactly this bug (item
         * 39) and was safe by the same kind of distant guarantee right up until
         * it wasn't.
         */
        const absoluteInput = resolve(inputPath);
        for (const seg of segments) {
            // Escape single quotes in path for ffconcat format
            const escapedPath = absoluteInput.replace(/'/g, "'\\''");
            lines.push(`file '${escapedPath}'`);
            // Trimming and aligning are the same operation here, so the
            // alignment is folded into the in-points rather than added as a
            // second seek in front of the concat demuxer — which would shift
            // every kept range, not just the head.
            //
            // Misalignment exists only at the head of the source: past the
            // latest-starting stream's first frame every stream is present, so
            // a range beginning after that point is left exactly where the user
            // put it. Only a range starting inside the head region moves, and
            // it moves by at most the spread — a fraction of a second off the
            // front of that one range, in exchange for all of its streams
            // actually being there.
            lines.push(`inpoint ${Math.max(seg.inSec, alignmentOffset)}`);
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
        alignmentOffset = 0
    ): Promise<string[]> {
        const { inputPath, outputDir, encodeConfig } = opts;
        const renditions = encodeConfig.videoRenditions!;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const sourceFrameRate = await this.probeFrameRate(inputPath);
        const gopFrames = Math.round(segmentDuration * sourceFrameRate);
        const trimming = !!encodeConfig.trimSegments?.length;

        this.logger.log(
            `Source frame rate: ${sourceFrameRate.toFixed(2)} fps, GOP: ${gopFrames} frames (${segmentDuration}s segments)`
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
        } else if (hasReencode && this.accelMode === 'intel') {
            args.push('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv');
        }

        if (trimming) {
            const concatPath = await this.buildConcatFile(
                inputPath,
                encodeConfig.trimSegments!,
                outputDir,
                alignmentOffset
            );
            // The concat demuxer's inpoint seek is keyframe-granular, and it
            // lands where the file's *default* stream says by DTS — on a
            // multi-stream source each mapped stream can carry up to a GOP of
            // pre-roll before the cut, a different amount per stream. Left in,
            // the muxer clamps those backwards timestamps at every splice and
            // lip-sync slides by the per-stream difference. So every decoded
            // frame is tagged with its concat window (-segment_time_metadata)
            // and the select/aselect=concatdec_select filters below drop the
            // frames outside it — the cut becomes sample-accurate.
            //
            // -copyts is load-bearing: the window metadata is in the concat
            // demuxer's stitched clock, but without it ffmpeg shifts input
            // timestamps to start at zero — by exactly the pre-roll, since the
            // pre-roll holds the earliest packet — and the select filters then
            // cut a window displaced by up to a GOP (verified by frame
            // comparison, not a theory). The stitched clock already starts at
            // zero, so downstream muxing is unaffected.
            args.push(
                '-f',
                'concat',
                '-safe',
                '0',
                '-segment_time_metadata',
                '1',
                '-i',
                concatPath,
                '-copyts'
            );
        } else if (alignmentOffset > 0) {
            // Input-level, hence in front of `-i`, and not a `-filter_complex`
            // trim: a copy-mode rendition never passes through the filter graph
            // at all, so a filter-level trim would align the re-encoded streams
            // and leave the copied ones exactly as misaligned as they were. An
            // input seek is the only mechanism that reaches every stream.
            //
            // It follows the hwaccel flags because those are input options too,
            // and every input option has to be stated before the input it
            // applies to.
            args.push('-ss', String(alignmentOffset), '-i', inputPath);
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
                const trimSelect = trimming
                    ? 'select=concatdec_select,'
                    : '';
                filterParts.push(
                    `[0:v:${trackIdx}]${trimSelect}split=${entries.length}${splitOutputs}`
                );
                for (const e of entries) {
                    let scalerExpr: string;
                    if (this.accelMode === 'nvidia') {
                        scalerExpr = `scale_cuda=${e.rendition.width}:${e.rendition.height}`;
                    } else if (this.accelMode === 'apple') {
                        scalerExpr = `scale_vt=w=${e.rendition.width}:h=${e.rendition.height}`;
                    } else if (this.accelMode === 'intel') {
                        // vpp_qsv, not scale_qsv: the VPP filter is what current
                        // FFmpeg builds carry, and it keeps the frame in QSV
                        // memory so no download/upload round trip appears
                        // between decode and encode.
                        scalerExpr = `vpp_qsv=w=${e.rendition.width}:h=${e.rendition.height}`;
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
            } else if (this.accelMode === 'intel') {
                // Quick Sync. `-global_quality` with `-look_ahead 0` is QSV's
                // constant-quality mode, the counterpart of NVENC's `-cq`; the
                // scale is the same 0-51 range as x264's CRF, so the existing
                // bitrate-to-CRF mapping applies unchanged.
                args.push(
                    `-c:v:${videoOutputIndex}`,
                    'h264_qsv',
                    `-profile:v:${videoOutputIndex}`,
                    'high',
                    `-preset:v:${videoOutputIndex}`,
                    'medium'
                );
                if (r.vbr) {
                    const quality = this.bitrateToVideoCrf(
                        r.videoBitrateKbps,
                        r.width,
                        r.height,
                        sourceFrameRate
                    );
                    args.push(
                        `-global_quality:v:${videoOutputIndex}`,
                        `${quality}`,
                        `-look_ahead:v:${videoOutputIndex}`,
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
                // x264 puts a keyframe wherever it detects a cut, which lands
                // off the `-g` cadence below and takes the segment boundary
                // with it — the HLS muxer closes a chunk at the first keyframe
                // past `-hls_time`, so a scene change two seconds early yields
                // a short segment and the chain stops being uniform. NVENC and
                // VideoToolbox do not scene-cut unless asked, so this is the
                // CPU path's problem alone.
                args.push(`-sc_threshold:v:${videoOutputIndex}`, '0');
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

        // Trimmed audio takes the filter graph for the same concatdec_select
        // drop as video (a repeated -filter_complex is additive). A filter
        // input can only be consumed once, so a source track feeding several
        // groups is fanned out with asplit. Copy-mode audio cannot pass a
        // filter — the controller refuses copyStream with trimSegments.
        if (trimming) {
            const groupsByTrack = new Map<number, number[]>();
            audioGroups.forEach((group, i) => {
                const track = group.sourceTrackIndex;
                if (!groupsByTrack.has(track)) groupsByTrack.set(track, []);
                groupsByTrack.get(track)!.push(i);
            });
            const audioParts: string[] = [];
            for (const [trackIdx, outs] of groupsByTrack) {
                const labels = outs.map((i) => `[aout${i}]`).join('');
                audioParts.push(
                    outs.length === 1
                        ? `[0:a:${trackIdx}]aselect=concatdec_select${labels}`
                        : `[0:a:${trackIdx}]aselect=concatdec_select,asplit=${outs.length}${labels}`
                );
            }
            args.push('-filter_complex', audioParts.join(';'));
        }

        for (const group of audioGroups) {
            args.push(
                '-map',
                trimming
                    ? `[aout${audioOutputIndex}]`
                    : `0:a:${group.sourceTrackIndex}`
            );
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

        // HLS output options. fMP4 unconditionally: CMAF-compatible, lower
        // per-segment overhead, and the format every current player is happiest
        // with. Sources whose streams do not start together are aligned at the
        // input above rather than escaped into MPEG-TS.
        const segExt = 'm4s';
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
            'fmp4',
            '-master_pl_name',
            'master.m3u8',
            '-hls_fmp4_init_filename',
            'init.mp4',
            '-movflags',
            '+negative_cts_offsets+default_base_moof'
        );

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
        alignmentOffset = 0
    ): Promise<string[]> {
        const { inputPath, outputDir, encodeConfig } = opts;
        const audioGroups = encodeConfig.audioGroups!;
        const segmentDuration = encodeConfig.segmentDuration ?? 6;
        const trimming = !!encodeConfig.trimSegments?.length;
        const args: string[] = [];

        if (trimming) {
            const concatPath = await this.buildConcatFile(
                inputPath,
                encodeConfig.trimSegments!,
                outputDir,
                alignmentOffset
            );
            // See buildVideoArgs: the metadata flag + aselect drop the
            // keyframe-inexact seek pre-roll, and -copyts keeps the frames in
            // the clock the window metadata refers to.
            args.push(
                '-f',
                'concat',
                '-safe',
                '0',
                '-segment_time_metadata',
                '1',
                '-i',
                concatPath,
                '-copyts'
            );
        } else if (alignmentOffset > 0) {
            // See buildVideoArgs: input-level, so it reaches copied streams too.
            args.push('-ss', String(alignmentOffset), '-i', inputPath);
        } else {
            args.push('-i', inputPath);
        }
        args.push('-threads', String(this.threads));

        args.push('-progress', 'pipe:2', '-stats_period', '1');
        args.push('-vn');

        if (trimming) {
            const groupsByTrack = new Map<number, number[]>();
            audioGroups.forEach((group, i) => {
                const track = group.sourceTrackIndex;
                if (!groupsByTrack.has(track)) groupsByTrack.set(track, []);
                groupsByTrack.get(track)!.push(i);
            });
            const audioParts: string[] = [];
            for (const [trackIdx, outs] of groupsByTrack) {
                const labels = outs.map((i) => `[aout${i}]`).join('');
                audioParts.push(
                    outs.length === 1
                        ? `[0:a:${trackIdx}]aselect=concatdec_select${labels}`
                        : `[0:a:${trackIdx}]aselect=concatdec_select,asplit=${outs.length}${labels}`
                );
            }
            args.push('-filter_complex', audioParts.join(';'));
        }

        audioGroups.forEach((group, i) => {
            args.push(
                '-map',
                trimming ? `[aout${i}]` : `0:a:${group.sourceTrackIndex}`
            );
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

        const segExt = 'm4s';
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
            'fmp4',
            '-master_pl_name',
            'master.m3u8',
            '-hls_fmp4_init_filename',
            'init.mp4',
            '-movflags',
            '+negative_cts_offsets+default_base_moof'
        );

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

        // Settled before anything is built: a source whose streams do not start
        // together is seeked past the head so that they do, and the output is
        // fMP4 either way.
        const alignmentOffset = await this.computeAlignmentOffset(
            opts.inputPath,
            encodeConfig
        );

        // What the output will be, not what the input is. Progress is FFmpeg's
        // out_time over this figure, and an aligned encode never reaches the
        // source's full duration — the head it seeked past is duration it will
        // never write — so leaving the offset in would park the bar short of
        // 100% on precisely the sources this change exists for. A trimmed
        // encode already measures its kept ranges, and the alignment is folded
        // into those in-points rather than added to them.
        const totalDuration = encodeConfig.trimSegments?.length
            ? encodeConfig.trimSegments.reduce(
                  (sum, s) => sum + (s.outSec - s.inSec),
                  0
              )
            : Math.max(
                  0,
                  (await this.probeDuration(opts.inputPath)) - alignmentOffset
              );
        const args =
            type === 'video'
                ? await this.buildVideoArgs(opts, alignmentOffset)
                : await this.buildAudioArgs(opts, alignmentOffset);

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
                        segmentFormat: 'fmp4',
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

    /**
     * Which byte-range chunk chain each stream directory's segments belong to.
     *
     * Packing shares one chain across several streams, and this is where the
     * grouping is decided — from the config that named the directories, never
     * by reading a name back apart. The names are built below out of labels the
     * user typed; a reader that re-derived the angle from a `_t1_` infix would
     * be one label containing an underscore away from packing an angle into the
     * wrong chain, and would say nothing about it.
     *
     * One chain per video angle, holding every rendition of that angle: the
     * target CDN class forwards a requested range to the client immediately
     * while backhauling the whole object, so one chunk pull warms every
     * rendition of the angle at the edge and an ABR step-up never lands on a
     * cold object. Audio gets a single chain of its own instead of riding along
     * — it is needed *concurrently* with video rather than swapped for it, so
     * merging would duplicate it into every angle's chunks, and keeping it
     * apart is what lets audio-only playback pull no video bytes at all.
     */
    buildStreamChainMap(encodeConfig: EncodeConfigDto): Record<string, string> {
        const chains: Record<string, string> = {};

        if (encodeConfig.type === 'video') {
            const renditions = encodeConfig.videoRenditions ?? [];
            // The same test buildVideoArgs applies when it names the stream
            // directories, and it has to stay the same test: a different answer
            // here maps chains onto directories that do not exist.
            const multiTrack =
                new Set(renditions.map((r) => r.sourceTrackIndex ?? 0)).size >
                1;
            for (const rendition of renditions) {
                const name = this.buildVideoStreamName(rendition, multiTrack);
                chains[`stream_${name}`] =
                    `v${rendition.sourceTrackIndex ?? 0}`;
            }
        }

        // Audio-only encodes fall through to exactly this and nothing else,
        // which is the whole special case they need.
        for (const group of encodeConfig.audioGroups ?? []) {
            chains[`stream_${this.buildAudioStreamName(group)}`] = 'a';
        }

        return chains;
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
