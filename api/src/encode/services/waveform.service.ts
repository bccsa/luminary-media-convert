import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { ffmpegBin } from './ffbin.js';

/**
 * The sidecar format peaks are written at, and the only one a cached sidecar is
 * accepted at.
 *
 * 2 since the peaks span the timeline rather than the audio stream: a source
 * whose audio starts a second into the presentation is silence at the head of
 * the envelope, not its first sample drawn at position zero. Version 1 files
 * outlive the process — a session in `uploaded` is restored from disk with its
 * work directory intact — so a version check is what stops a sidecar written
 * before that fix being served for the rest of the session's life.
 */
export const WAVEFORM_SIDECAR_VERSION = 2;

export interface WaveformSidecar {
    /** {@link WAVEFORM_SIDECAR_VERSION} the peaks were computed at. */
    version: number;
    sampleRate: number;
    numPeaks: number;
    peaks: number[];
}

/**
 * The sidecar at `path`, or null when there is nothing there worth reusing.
 *
 * A sidecar from an older version described a different timeline, so it is
 * treated as absent rather than migrated: recomputing costs one ffmpeg pass and
 * is what makes the alignment fix reach sessions that already exist on disk.
 * Unreadable and shapeless files take the same route — this is derived data,
 * and anything that cannot be trusted is cheaper to rebuild than to reason
 * about.
 *
 * A function rather than a method because both readers of the cache want it:
 * the HTTP path through {@link WaveformService.getOrComputeCached}, and the
 * encode, which used to copy the file into the output whole and so was exactly
 * the path that would not have noticed the version.
 */
export async function readCachedWaveform(
    path: string
): Promise<WaveformSidecar | null> {
    if (!existsSync(path)) return null;
    // Logged under the service's own context: a rejected cache is silent to the
    // user — the peaks simply arrive a pass later — so this line is the only
    // place it is visible at all.
    const logger = new Logger(WaveformService.name);
    try {
        const sidecar = JSON.parse(
            await readFile(path, 'utf-8')
        ) as WaveformSidecar;
        if (!Array.isArray(sidecar?.peaks)) {
            logger.warn(
                `Cached waveform at ${path} has no peaks. Recomputing.`
            );
            return null;
        }
        if (sidecar.version !== WAVEFORM_SIDECAR_VERSION) {
            logger.log(
                `Cached waveform at ${path} is version ${sidecar.version}, ` +
                    `not ${WAVEFORM_SIDECAR_VERSION}. Recomputing.`
            );
            return null;
        }
        return sidecar;
    } catch (err) {
        logger.warn(
            `Failed to read cached waveform at ${path}: ${(err as Error).message}. Recomputing.`
        );
        return null;
    }
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
     *
     * These peaks describe the **source** timeline, which is why the options
     * stop short of {@link generateWaveform}'s `startOffsetSec`: the readers
     * here are the trim UI and its filmstrip, and they scrub the source
     * preview, not the encode. The delivered sidecar is the one that removes
     * the encode's alignment head, and it is generated separately.
     */
    async getOrComputeCached(
        sessionId: string,
        opts: {
            inputPath: string;
            concatFilePath?: string;
            numPeaks?: number;
            durationSec?: number;
        }
    ): Promise<WaveformSidecar> {
        const cachePath = this.cachePath(sessionId);

        // Anything the version check turns down is recomputed and overwritten
        // below, so a session carrying a stale sidecar heals on first read
        // rather than staying wrong for as long as it exists.
        const cached = await readCachedWaveform(cachePath);
        if (cached) return cached;

        const existing = this.inFlight.get(sessionId);
        if (existing) return existing;

        const promise = (async () => {
            const peaks = await this.generateWaveform(opts);
            const sidecar: WaveformSidecar = {
                version: WAVEFORM_SIDECAR_VERSION,
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
        /**
         * Length of the timeline the peaks will be drawn across — the source
         * duration, or the summed trim segments for a concat input. Without it
         * audio that ends before the timeline does is stretched to fill it.
         */
        durationSec?: number;
        /**
         * Source seconds to drop from the head, for peaks that have to line up
         * with an encode that seeked past it (`EncodeResult.alignmentOffset`).
         * Ignored on a concat input, where the offset is already inside the
         * in-points and applying it again would cut a second time.
         */
        startOffsetSec?: number;
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

        // Dropped on a concat input rather than trusted: buildConcatFile clamps
        // every in-point to the offset already, so seeking again would cut a
        // second head off the first kept range.
        const startOffsetSec = opts.concatFilePath
            ? 0
            : (opts.startOffsetSec ?? 0);

        // See buildVideoArgs in ffmpeg.service.ts: on a concat input the
        // metadata flag + aselect drop the keyframe-inexact seek pre-roll, and
        // -copyts keeps the frames in the clock the window metadata refers to.
        // Left in, the pre-roll is packets from before the cut, and the peaks
        // would describe audio the encode does not contain. The stitched clock
        // starts at zero either way, so nothing below sees a large timestamp.
        //
        // A direct input deliberately takes no -copyts. Without it ffmpeg
        // rebases the input on the container's own start time — which is the
        // zero the client draws from — while keeping each stream's offset
        // against it, so the audio's lateness survives and nothing else does.
        // With it, a container that does not start near zero hands first_pts=0
        // below a gap the size of its base timestamp to fill with silence, and
        // MPEG-TS routinely starts wherever the recorder's clock was: measured
        // on a 10-second .ts stamped at 3600s, 57MB of PCM came back, all but
        // ten seconds of it silence, and the peaks were the waveform of nothing.
        const inputArgs = opts.concatFilePath
            ? [
                  '-f',
                  'concat',
                  '-safe',
                  '0',
                  '-segment_time_metadata',
                  '1',
                  '-i',
                  opts.concatFilePath,
                  '-copyts',
              ]
            : [
                  // In front of `-i`, so it is an input seek: the same
                  // mechanism the encode aligns with, and audio decoding makes
                  // it sample-accurate rather than keyframe-granular. The seek
                  // rebases the timestamps, so first_pts=0 below then pads only
                  // a gap that is genuinely still there — an audio stream that
                  // starts after the offset rather than before it.
                  ...(startOffsetSec > 0
                      ? ['-ss', String(startOffsetSec)]
                      : []),
                  '-i',
                  resolvedInput,
              ];

        // Peak 0 has to mean timeline zero. A source whose audio stream starts
        // late — a second in, on a multi-camera recording — otherwise has its
        // first decoded sample drawn at the origin and the whole waveform sits
        // that far early. async=1 with first_pts=0 fills the gap with silence
        // instead. The concat clock already starts at zero, so first_pts=0 is a
        // no-op there.
        const filters: string[] = [];
        if (opts.concatFilePath) filters.push('aselect=concatdec_select');
        filters.push(
            'aresample=8000:async=1:first_pts=0',
            'aformat=sample_fmts=s16:channel_layouts=mono'
        );
        // And the tail: audio that runs out before the timeline does would be
        // stretched across it by the client, which draws the peaks edge to edge.
        if (opts.durationSec && opts.durationSec > 0) {
            filters.push(`apad=whole_dur=${opts.durationSec}`);
        }

        return new Promise((resolve, reject) => {
            let errOutput = '';

            const ffmpeg = spawn(ffmpegBin(), [
                ...inputArgs,
                // Nothing here looks at the picture; without this ffmpeg still
                // demuxes and decodes it alongside the audio.
                '-vn',
                '-af',
                filters.join(','),
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
