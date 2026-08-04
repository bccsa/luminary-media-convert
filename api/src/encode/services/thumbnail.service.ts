import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { FFMPEG } from './ffmpeg-bin.js';

const execFileAsync = promisify(execFile);

const THUMB_WIDTH = 160;
const INTERVAL_SECONDS = 5;
const COLUMNS = 5;
const ROWS = 5;
const THUMBS_PER_SPRITE = COLUMNS * ROWS;

interface SpriteFormat {
    encoder: string;
    ext: string;
    args: string[];
}

export interface ThumbnailResult {
    vttRelativePath: string;
}

export interface PreviewThumbnails {
    /** WebVTT cue text, sprite files referenced by bare filename. */
    vtt: string;
    /** Directory holding the sprite sheets the VTT refers to. */
    dir: string;
    /**
     * False while the sampling pass is still running: the cues cover only the
     * part of the source sampled so far, and asking again later gets more.
     */
    complete: boolean;
}

@Injectable()
export class ThumbnailService {
    private readonly logger = new Logger(ThumbnailService.name);
    private spriteFormat: SpriteFormat | null | undefined = undefined;
    private decodeAccel: string[] | undefined = undefined;
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');
    /** In-flight generations keyed by sessionId, so two tabs share one ffmpeg pass. */
    private readonly inFlight = new Map<
        string,
        Promise<ThumbnailResult | null>
    >();

    /** Where a session's pre-encode storyboard lives. */
    previewDir(sessionId: string): string {
        return join(this.workDir, sessionId, 'preview-thumbnails');
    }

    /**
     * Drop the source storyboard. Once the encode has produced its own, this one
     * describes material the client no longer looks at, and the session directory
     * is not otherwise pruned until the session is deleted.
     */
    async removePreview(sessionId: string): Promise<void> {
        try {
            await rm(this.previewDir(sessionId), {
                recursive: true,
                force: true,
            });
        } catch (err) {
            this.logger.warn(
                `Could not remove source storyboard for ${sessionId}: ${(err as Error).message}`
            );
        }
    }

    /**
     * Storyboard for the uploaded source, generated before any encode so the trim
     * timeline has frames to show. The encode writes its own storyboard for the
     * finished output; this one describes the source and is thrown away with the
     * session directory.
     *
     * Returns null when the source has no usable video, or ffmpeg cannot produce
     * sprites — the timeline simply goes without.
     */
    async getOrGeneratePreview(
        sessionId: string,
        opts: {
            inputPath: string;
            duration: number;
            sourceWidth: number;
            sourceHeight: number;
        }
    ): Promise<PreviewThumbnails | null> {
        const dir = this.previewDir(sessionId);
        // generateThumbnails writes into <outputDir>/thumbnails. The finished VTT
        // lands there too — looking for it one level up meant the cache never hit,
        // and every request after the first started another full pass.
        const producedDir = join(dir, 'thumbnails');
        const vttPath = join(producedDir, 'thumbnails.vtt');

        if (existsSync(vttPath)) {
            try {
                return {
                    vtt: await readFile(vttPath, 'utf-8'),
                    dir: producedDir,
                    complete: true,
                };
            } catch (err) {
                this.logger.warn(
                    `Failed to read cached storyboard for ${sessionId}: ${(err as Error).message}. Regenerating.`
                );
            }
        }

        if (!this.inFlight.has(sessionId)) {
            const run = this.generateThumbnails({
                inputPath: opts.inputPath,
                outputDir: dir,
                duration: opts.duration,
                sourceWidth: opts.sourceWidth,
                sourceHeight: opts.sourceHeight,
            })
                .catch((err: Error) => {
                    this.logger.warn(
                        `Storyboard generation failed for ${sessionId}: ${err.message}`
                    );
                    return null;
                })
                .finally(() => {
                    this.inFlight.delete(sessionId);
                });
            this.inFlight.set(sessionId, run);
        }

        // Deliberately not awaited. Sampling an hour of video takes minutes, and
        // waiting for the last sprite held the request open for all of it — the
        // timeline stayed empty with nothing to say why. Sprites are numbered and
        // each covers a fixed span, so the ones already written make a perfectly
        // valid storyboard for the part of the timeline they cover.
        return this.partialPreview(producedDir, opts);
    }

    /** A storyboard for however much of the source has been sampled so far. */
    private async partialPreview(
        producedDir: string,
        opts: { duration: number; sourceWidth: number; sourceHeight: number }
    ): Promise<PreviewThumbnails | null> {
        const format = await this.detectSpriteFormat();
        if (!format) return null;

        let sprites: string[];
        try {
            sprites = (await readdir(producedDir))
                .filter(
                    (f) =>
                        f.startsWith('sprite_') && f.endsWith(`.${format.ext}`)
                )
                .sort();
        } catch {
            return null; // Nothing written yet.
        }
        if (sprites.length === 0) return null;

        return {
            vtt: this.buildVtt(
                opts.duration,
                sprites,
                THUMB_WIDTH,
                this.thumbHeightFor(opts.sourceWidth, opts.sourceHeight)
            ),
            dir: producedDir,
            complete: false,
        };
    }

    /** Sprite height for the source's aspect ratio, kept even for the encoders. */
    private thumbHeightFor(sourceWidth: number, sourceHeight: number): number {
        return Math.ceil(((THUMB_WIDTH / sourceWidth) * sourceHeight) / 2) * 2;
    }

    private async detectSpriteFormat(): Promise<SpriteFormat | null> {
        if (this.spriteFormat !== undefined) return this.spriteFormat;
        try {
            const { stdout } = await execFileAsync(FFMPEG, ['-encoders'], {
                timeout: 10_000,
            });
            if (stdout.includes('libwebp')) {
                this.spriteFormat = {
                    encoder: 'libwebp',
                    ext: 'webp',
                    args: ['-quality', '30', '-compression_level', '6'],
                };
            } else if (/\bmjpeg\b/.test(stdout)) {
                this.spriteFormat = {
                    encoder: 'mjpeg',
                    ext: 'jpg',
                    args: ['-q:v', '8'],
                };
            } else {
                this.spriteFormat = null;
            }
        } catch {
            this.spriteFormat = null;
        }
        if (!this.spriteFormat) {
            this.logger.warn(
                'No suitable image encoder (libwebp/mjpeg) available — thumbnail generation disabled'
            );
        } else {
            this.logger.log(
                `Thumbnail sprite format: ${this.spriteFormat.ext} (${this.spriteFormat.encoder})`
            );
        }
        return this.spriteFormat;
    }

    /**
     * Decoder acceleration for the storyboard pass, detected once.
     *
     * Deliberately no `-hwaccel_output_format`: the filter chain below scales and
     * tiles in software, so the frames have to come back to system memory. That is
     * the opposite of the preview encoder, where `scale_cuda` needs them to stay
     * on the device — passing the wrong one of those two breaks the filter graph.
     *
     * Only the decode is accelerated, which is the expensive half here: an hour of
     * 1080p50 HEVC is a long software decode, and the pass has to walk the whole
     * file to sample it.
     */
    private async detectDecodeAccel(): Promise<string[]> {
        if (this.decodeAccel !== undefined) return this.decodeAccel;
        try {
            const { stdout } = await execFileAsync(FFMPEG, ['-hwaccels'], {
                timeout: 10_000,
            });
            if (stdout.includes('cuda'))
                this.decodeAccel = ['-hwaccel', 'cuda'];
            else if (
                process.platform === 'darwin' &&
                stdout.includes('videotoolbox')
            )
                this.decodeAccel = ['-hwaccel', 'videotoolbox'];
            else this.decodeAccel = [];
        } catch {
            this.decodeAccel = [];
        }
        if (this.decodeAccel.length > 0) {
            this.logger.log(
                `Thumbnail decode acceleration: ${this.decodeAccel[1]}`
            );
        }
        return this.decodeAccel;
    }

    /**
     * How long the storyboard pass is allowed to take.
     *
     * A fixed cap cannot work: the pass walks the entire source, so the work grows
     * with runtime while the budget did not. Five minutes was enough for the short
     * clips this was built against and cut an hour-long file off after a third of
     * it, leaving a timeline whose thumbnails simply stopped. Allow a second of
     * wall clock per four seconds of source, with the old five minutes as the
     * floor and half an hour as a backstop against a pathological file.
     *
     * Rounded because durations are fractional — 3597.4s of video worked out to
     * a timeout of 899340.25ms, and `execFile` rejects anything but an unsigned
     * integer, so both the accelerated attempt and its software retry died before
     * ffmpeg was even started.
     */
    private timeoutFor(durationSeconds: number): number {
        const scaled = (durationSeconds / 4) * 1000;
        return Math.round(Math.min(Math.max(scaled, 300_000), 1_800_000));
    }

    async generateThumbnails(opts: {
        inputPath: string;
        outputDir: string;
        duration: number;
        sourceWidth: number;
        sourceHeight: number;
        concatFilePath?: string;
    }): Promise<ThumbnailResult | null> {
        const format = await this.detectSpriteFormat();
        if (!format) return null;
        if (opts.duration <= 0) return null;

        const thumbHeight =
            Math.ceil(
                ((THUMB_WIDTH / opts.sourceWidth) * opts.sourceHeight) / 2
            ) * 2;

        const thumbnailDir = join(opts.outputDir, 'thumbnails');
        await mkdir(thumbnailDir, { recursive: true });

        const spritePattern = join(thumbnailDir, `sprite_%03d.${format.ext}`);

        const inputArgs = opts.concatFilePath
            ? ['-f', 'concat', '-safe', '0', '-i', opts.concatFilePath]
            : ['-i', opts.inputPath];

        const filterArgs = [
            '-vf',
            `fps=1/${INTERVAL_SECONDS},scale=${THUMB_WIDTH}:${thumbHeight},tile=${COLUMNS}x${ROWS}`,
            '-c:v',
            format.encoder,
            ...format.args,
            '-an',
            spritePattern,
        ];
        const timeout = this.timeoutFor(opts.duration);
        const accel = await this.detectDecodeAccel();

        const run = (decodeArgs: string[]) =>
            execFileAsync(
                FFMPEG,
                [...decodeArgs, ...inputArgs, ...filterArgs],
                { timeout }
            );

        try {
            await run(accel);
        } catch (err) {
            // The GPU may simply not decode this codec — retry in software rather
            // than lose the storyboard over it. Nothing is retried when there was
            // no acceleration to begin with: the failure is then real.
            if (accel.length === 0) {
                this.logger.warn(
                    `FFmpeg thumbnail generation failed: ${(err as Error).message}`
                );
                return null;
            }
            this.logger.warn(
                `Accelerated thumbnail decode failed, retrying in software: ${(err as Error).message}`
            );
            try {
                await run([]);
            } catch (softwareErr) {
                this.logger.warn(
                    `FFmpeg thumbnail generation failed: ${(softwareErr as Error).message}`
                );
                return null;
            }
        }

        const spriteFiles = (await readdir(thumbnailDir))
            .filter(
                (f) => f.startsWith('sprite_') && f.endsWith(`.${format.ext}`)
            )
            .sort();

        if (spriteFiles.length === 0) {
            this.logger.warn('No sprite sheets were generated');
            return null;
        }

        const vttContent = this.buildVtt(
            opts.duration,
            spriteFiles,
            THUMB_WIDTH,
            thumbHeight
        );
        const vttPath = join(thumbnailDir, 'thumbnails.vtt');
        await writeFile(vttPath, vttContent, 'utf-8');

        this.logger.log(
            `Generated ${spriteFiles.length} thumbnail sprite sheet(s) for ${Math.floor(opts.duration)}s video`
        );

        return { vttRelativePath: 'thumbnails/thumbnails.vtt' };
    }

    buildVtt(
        duration: number,
        spriteFiles: string[],
        thumbWidth: number,
        thumbHeight: number
    ): string {
        const totalThumbs = Math.ceil(duration / INTERVAL_SECONDS);
        const lines: string[] = ['WEBVTT', ''];

        for (let i = 0; i < totalThumbs; i++) {
            const startTime = i * INTERVAL_SECONDS;
            const endTime = Math.min((i + 1) * INTERVAL_SECONDS, duration);

            const spriteIndex = Math.floor(i / THUMBS_PER_SPRITE);
            const posInSprite = i % THUMBS_PER_SPRITE;
            const col = posInSprite % COLUMNS;
            const row = Math.floor(posInSprite / COLUMNS);

            const spriteFile = spriteFiles[spriteIndex];
            if (!spriteFile) break;

            const x = col * thumbWidth;
            const y = row * thumbHeight;

            lines.push(
                `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`
            );
            lines.push(
                `${spriteFile}#xywh=${x},${y},${thumbWidth},${thumbHeight}`
            );
            lines.push('');
        }

        return lines.join('\n');
    }
}

export function formatVttTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds - Math.floor(seconds)) * 1000);

    return (
        String(h).padStart(2, '0') +
        ':' +
        String(m).padStart(2, '0') +
        ':' +
        String(s).padStart(2, '0') +
        '.' +
        String(ms).padStart(3, '0')
    );
}
