import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { mkdir, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

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

@Injectable()
export class ThumbnailService {
    private readonly logger = new Logger(ThumbnailService.name);
    private spriteFormat: SpriteFormat | null | undefined = undefined;

    private async detectSpriteFormat(): Promise<SpriteFormat | null> {
        if (this.spriteFormat !== undefined) return this.spriteFormat;
        try {
            const { stdout } = await execFileAsync('ffmpeg', ['-encoders'], {
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
                'No suitable image encoder (libwebp/mjpeg) available — thumbnail generation disabled',
            );
        } else {
            this.logger.log(
                `Thumbnail sprite format: ${this.spriteFormat.ext} (${this.spriteFormat.encoder})`,
            );
        }
        return this.spriteFormat;
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
            Math.ceil(((THUMB_WIDTH / opts.sourceWidth) * opts.sourceHeight) / 2) * 2;

        const thumbnailDir = join(opts.outputDir, 'thumbnails');
        await mkdir(thumbnailDir, { recursive: true });

        const spritePattern = join(thumbnailDir, `sprite_%03d.${format.ext}`);

        const inputArgs = opts.concatFilePath
            ? ['-f', 'concat', '-safe', '0', '-i', opts.concatFilePath]
            : ['-i', opts.inputPath];

        try {
            await execFileAsync(
                'ffmpeg',
                [
                    ...inputArgs,
                    '-vf', `fps=1/${INTERVAL_SECONDS},scale=${THUMB_WIDTH}:${thumbHeight},tile=${COLUMNS}x${ROWS}`,
                    '-c:v', format.encoder,
                    ...format.args,
                    '-an',
                    spritePattern,
                ],
                { timeout: 300_000 },
            );
        } catch (err) {
            this.logger.warn(
                `FFmpeg thumbnail generation failed: ${(err as Error).message}`,
            );
            return null;
        }

        const spriteFiles = (await readdir(thumbnailDir))
            .filter((f) => f.startsWith('sprite_') && f.endsWith(`.${format.ext}`))
            .sort();

        if (spriteFiles.length === 0) {
            this.logger.warn('No sprite sheets were generated');
            return null;
        }

        const vttContent = this.buildVtt(
            opts.duration,
            spriteFiles,
            THUMB_WIDTH,
            thumbHeight,
        );
        const vttPath = join(thumbnailDir, 'thumbnails.vtt');
        await writeFile(vttPath, vttContent, 'utf-8');

        this.logger.log(
            `Generated ${spriteFiles.length} thumbnail sprite sheet(s) for ${Math.floor(opts.duration)}s video`,
        );

        return { vttRelativePath: 'thumbnails/thumbnails.vtt' };
    }

    buildVtt(
        duration: number,
        spriteFiles: string[],
        thumbWidth: number,
        thumbHeight: number,
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

            lines.push(`${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`);
            lines.push(`${spriteFile}#xywh=${x},${y},${thumbWidth},${thumbHeight}`);
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
