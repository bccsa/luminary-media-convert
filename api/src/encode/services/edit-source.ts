/**
 * What adding to an existing video takes from the editor: a file on this
 * machine or a link, checked before it is read.
 */
import { BadRequestException } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { isAbsolute } from 'path';
import { hasAllowedExtension } from './media-extensions.js';

/** An http(s) link rather than a path on this machine. */
export const isLink = (source: string): boolean => /^https?:\/\//i.test(source);

/** An HLS playlist link: its streams are listed from the playlist itself. */
export const isHlsLink = (source: string): boolean =>
    isLink(source) && /\.m3u8$/i.test(new URL(source).pathname);

/** A path on this machine to a media file, or an http(s) link; a 400 otherwise. */
export function assertReadableSource(path: string): void {
    if (isLink(path)) {
        try {
            new URL(path);
        } catch {
            throw new BadRequestException('That is not a valid link');
        }
        return;
    }
    if (!isAbsolute(path) || !existsSync(path)) {
        throw new BadRequestException('No file at that path');
    }
    if (!hasAllowedExtension(path)) {
        throw new BadRequestException(
            'That is not an audio or video file the encoder reads'
        );
    }
}

/** Runs `bin` to its end: its standard output, or its error output as the rejection. */
export function runProcess(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (c: Buffer) => (out += c.toString()));
        child.stderr.on('data', (c: Buffer) => (err += c.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve(out)
                : reject(new Error(err.trim() || `${bin} failed`))
        );
    });
}

/**
 * Runs an FFmpeg encode that reports with `-progress pipe:1`, passing on how
 * far it is as a share of `durationSec`. Rejects with FFmpeg's last error
 * line after `failure`, the error carrying the end of FFmpeg's output as `stderr`.
 */
export function runEncode(
    bin: string,
    args: string[],
    durationSec: number,
    onProgress: (pct: number) => void,
    failure: string
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderr = '';
        child.stdout.on('data', (chunk: Buffer) => {
            const match = /out_time_us=(\d+)/.exec(chunk.toString());
            if (match && durationSec > 0) {
                onProgress(
                    Math.min(
                        100,
                        Math.round((Number(match[1]) / 1e6 / durationSec) * 100)
                    )
                );
            }
        });
        child.stderr.on(
            'data',
            (chunk: Buffer) =>
                (stderr = (stderr + chunk.toString()).slice(-4000))
        );
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(
                      Object.assign(
                          new Error(
                              `${failure}: ${stderr.trim().split('\n').pop()}`
                          ),
                          { stderr }
                      )
                  )
        );
    });
}
