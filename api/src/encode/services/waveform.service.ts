import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

export interface WaveformSidecar {
    version: number;
    sampleRate: number;
    numPeaks: number;
    peaks: number[];
}

/**
 * Samples folded into one envelope entry — 0.1s at the 8kHz the audio is
 * resampled to. Fine enough that resampling down to the requested peak count
 * loses nothing visible, and small enough that an hour of audio is 36,000
 * numbers rather than 58MB of decoded PCM.
 */
const SAMPLES_PER_ENVELOPE_BUCKET = 800;

/**
 * Reduces the coarse envelope to the requested number of peaks, keeping the
 * loudest value in each span. Peaks are an outline, so a mean here would flatten
 * exactly the transients the outline exists to show.
 */
export function resampleEnvelope(
    envelope: readonly number[],
    numPeaks: number
): number[] {
    if (envelope.length === 0 || numPeaks <= 0) return [];
    // Already at or below the target: nothing to merge, and stretching it would
    // invent detail that was never sampled.
    if (envelope.length <= numPeaks) return [...envelope];

    const peaks = new Array<number>(numPeaks);
    for (let i = 0; i < numPeaks; i++) {
        const start = Math.floor((i * envelope.length) / numPeaks);
        const end = Math.max(
            start + 1,
            Math.floor(((i + 1) * envelope.length) / numPeaks)
        );
        let max = 0;
        for (let j = start; j < end && j < envelope.length; j++) {
            if (envelope[j] > max) max = envelope[j];
        }
        peaks[i] = max;
    }
    return peaks;
}

@Injectable()
export class WaveformService {
    private readonly logger = new Logger(WaveformService.name);
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');
    /** In-flight computes keyed by sessionId — coalesces concurrent requests. */
    private readonly inFlight = new Map<string, Promise<WaveformSidecar>>();

    /**
     * Return the cached sidecar for a session if available; otherwise compute
     * it, write it to disk, and return it. Concurrent calls for the same
     * sessionId share the in-flight ffmpeg pass via the inFlight map, so two
     * tabs racing for the trim UI never spawn duplicate work.
     *
     * Cache path: `${WORK_DIR}/<sessionId>/waveform.json`. The full session
     * directory is rm -rf'd on session delete, so no separate invalidation.
     */
    async getOrComputeCached(
        sessionId: string,
        opts: { inputPath: string; concatFilePath?: string; numPeaks?: number }
    ): Promise<WaveformSidecar> {
        const cachePath = this.cachePath(sessionId);

        if (existsSync(cachePath)) {
            try {
                const body = await readFile(cachePath, 'utf-8');
                return JSON.parse(body) as WaveformSidecar;
            } catch (err) {
                this.logger.warn(
                    `Failed to read cached waveform for ${sessionId}: ${(err as Error).message}. Recomputing.`
                );
            }
        }

        const existing = this.inFlight.get(sessionId);
        if (existing) return existing;

        const promise = (async () => {
            const peaks = await this.generateWaveform(opts);
            const sidecar: WaveformSidecar = {
                version: 1,
                sampleRate: 8000,
                numPeaks: peaks.length,
                peaks,
            };
            try {
                await mkdir(dirname(cachePath), { recursive: true });
                await writeFile(cachePath, JSON.stringify(sidecar));
            } catch (err) {
                this.logger.warn(
                    `Failed to write waveform cache for ${sessionId}: ${(err as Error).message}`
                );
            }
            return sidecar;
        })().finally(() => {
            this.inFlight.delete(sessionId);
        });

        this.inFlight.set(sessionId, promise);
        return promise;
    }

    cachePath(sessionId: string): string {
        return join(this.workDir, sessionId, 'waveform.json');
    }

    async generateWaveform(opts: {
        inputPath: string;
        concatFilePath?: string;
        numPeaks?: number;
    }): Promise<number[]> {
        const numPeaks = opts.numPeaks ?? 1000;
        let resolvedInput = opts.concatFilePath ?? opts.inputPath;
        this.logger.log(`generateWaveform called with input: ${resolvedInput}`);

        // For a direct input (no concat file), tolerate the upload-side rename
        // by falling back to whatever non-hidden file sits in the same dir.
        if (!opts.concatFilePath && !existsSync(resolvedInput)) {
            const dir = dirname(resolvedInput);
            this.logger.log(
                `File not found at ${resolvedInput}, checking directory: ${dir}`
            );

            if (existsSync(dir)) {
                try {
                    const allFiles = readdirSync(dir);
                    const files = allFiles.filter(
                        (f) => !f.startsWith('.') && !f.endsWith('.info')
                    );
                    if (files.length > 0) {
                        resolvedInput = join(dir, files[0]);
                        this.logger.log(
                            `Using first file in directory: ${resolvedInput}`
                        );
                    } else {
                        this.logger.warn(`No usable files found in ${dir}`);
                    }
                } catch (err) {
                    this.logger.error(
                        `Failed to list directory ${dir}: ${err}`
                    );
                }
            } else {
                this.logger.warn(`Directory does not exist: ${dir}`);
            }
        }

        if (!existsSync(resolvedInput)) {
            throw new Error(`Source file does not exist: ${resolvedInput}`);
        }

        const inputArgs = opts.concatFilePath
            ? ['-f', 'concat', '-safe', '0', '-i', opts.concatFilePath]
            : ['-i', resolvedInput];

        return new Promise((resolve, reject) => {
            let errOutput = '';

            const ffmpeg = spawn('ffmpeg', [
                ...inputArgs,
                // Nothing here looks at the picture; without this ffmpeg still
                // demuxes and decodes it alongside the audio.
                '-vn',
                '-af',
                'aresample=8000,aformat=sample_fmts=s16:channel_layouts=mono',
                '-f',
                's16le',
                'pipe:1',
            ]);

            // Reduce to a coarse envelope as the samples arrive rather than
            // holding the decoded audio. An hour of 8kHz mono s16 is ~58MB to
            // buffer and then walk again; the envelope for the same hour is
            // 36,000 floats, and the peaks are resampled from it at the end.
            const envelope: number[] = [];
            let bucketMax = 0;
            let bucketFill = 0;
            /** Trailing byte when a chunk splits a 16-bit sample. */
            let carry: number | null = null;

            const takeSample = (value: number) => {
                const amplitude = Math.abs(value) / 32768;
                if (amplitude > bucketMax) bucketMax = amplitude;
                if (++bucketFill >= SAMPLES_PER_ENVELOPE_BUCKET) {
                    envelope.push(Math.min(bucketMax, 1));
                    bucketMax = 0;
                    bucketFill = 0;
                }
            };

            ffmpeg.stdout.on('data', (chunk: Buffer) => {
                let offset = 0;
                if (carry !== null && chunk.length > 0) {
                    // Rejoin the sample the chunk boundary split. Little-endian,
                    // and it has to be sign-extended by hand: read as unsigned, a
                    // quiet negative sample looks like a full-scale positive one
                    // and would spike the waveform once every chunk.
                    const raw = ((chunk[0] << 8) | carry) & 0xffff;
                    takeSample(raw >= 0x8000 ? raw - 0x10000 : raw);
                    carry = null;
                    offset = 1;
                }
                const end = chunk.length - ((chunk.length - offset) % 2);
                for (let i = offset; i < end; i += 2) {
                    takeSample(chunk.readInt16LE(i));
                }
                if (end < chunk.length) carry = chunk[end];
            });

            ffmpeg.stderr.on('data', (data: Buffer) => {
                errOutput += data.toString();
            });

            ffmpeg.on('error', (err) => {
                this.logger.error(`FFmpeg spawn error: ${err.message}`);
                reject(err);
            });

            ffmpeg.on('close', (code) => {
                if (code !== 0) {
                    this.logger.error(
                        `FFmpeg exited with code ${code}: ${errOutput}`
                    );
                    reject(new Error(`FFmpeg exited with code ${code}`));
                    return;
                }

                try {
                    // Whatever is left in the part-filled bucket still describes
                    // real audio — dropping it would shorten the waveform.
                    if (bucketFill > 0) envelope.push(Math.min(bucketMax, 1));
                    resolve(resampleEnvelope(envelope, numPeaks));
                } catch (err) {
                    this.logger.error(`Error computing peaks: ${err}`);
                    reject(err);
                }
            });
        });
    }
}
