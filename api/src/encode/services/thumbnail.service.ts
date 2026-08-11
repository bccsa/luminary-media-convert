import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';
import { ffmpegBin } from './ffbin.js';

const execFileAsync = promisify(execFile);

const THUMB_WIDTH = 160;
const INTERVAL_SECONDS = 5;
const COLUMNS = 5;
const ROWS = 5;
const THUMBS_PER_SPRITE = COLUMNS * ROWS;

/** Individual thumbs, one per sampled instant, as written at ingest. */
const THUMB_FILE_RE = /^thumb_\d+\.(webp|jpg|jpeg|png)$/;

interface SpriteFormat {
    encoder: string;
    ext: string;
    args: string[];
}

export interface ThumbnailResult {
    vttRelativePath: string;
}

/** The source video track the storyboard samples: dense video index plus dims. */
export interface StoryboardTrack {
    index: number;
    width: number;
    height: number;
}

/** A kept range of the source, in source seconds. */
interface KeptRange {
    inSec: number;
    outSec: number;
}

export interface PreviewThumbnails {
    /** WebVTT cue text, thumbnail files referenced by bare filename. */
    vtt: string;
    /** Directory holding the images the VTT refers to. */
    dir: string;
    /**
     * False while the sampling pass is still running: the cues cover only the
     * part of the source sampled so far, and asking again later gets more.
     */
    complete: boolean;
}

/**
 * Which video track the storyboard should sample.
 *
 * FFmpeg's default stream pick is "best", which on a multi-angle file is
 * whichever track it decides is highest quality — in practice it has landed on
 * a 256x144 proxy angle, so the timeline showed a postage stamp of the wrong
 * camera. Choose deliberately instead: the smallest track that is still at
 * least twice the thumbnail width (so the downscale to 160px has something to
 * work with), otherwise the largest track there is. Small first, because the
 * pass decodes the entire file and a 4K angle costs many times a 240p one for
 * frames nobody sees above 160px.
 *
 * The returned `index` is the dense per-type index ProbeService assigns, which
 * is exactly what `-map 0:v:N` wants.
 */
export function selectStoryboardTrack(
    tracks:
        | readonly { index: number; width?: number; height?: number }[]
        | undefined
): StoryboardTrack | null {
    const usable = (tracks ?? [])
        .filter((t) => (t.width ?? 0) > 0 && (t.height ?? 0) > 0)
        .map((t) => ({
            index: t.index,
            width: t.width as number,
            height: t.height as number,
        }));
    if (usable.length === 0) return null;

    const wideEnough = usable.filter((t) => t.width >= THUMB_WIDTH * 2);
    if (wideEnough.length > 0) {
        return wideEnough.reduce((best, t) =>
            t.width < best.width ? t : best
        );
    }
    return usable.reduce((best, t) => (t.width > best.width ? t : best));
}

@Injectable()
export class ThumbnailService {
    private readonly logger = new Logger(ThumbnailService.name);
    private spriteFormat: SpriteFormat | null | undefined = undefined;
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
     * timeline has frames to show. These are individual thumbnails, one per
     * sampled instant: the delivered output packs a selection of them into
     * sprite sheets at encode time, which is what makes a trimmed encode cost
     * nothing extra — no second decode of the source.
     *
     * Returns null when the source has no usable video, or ffmpeg cannot produce
     * images — the timeline simply goes without.
     */
    async getOrGeneratePreview(
        sessionId: string,
        opts: {
            inputPath: string;
            duration: number;
            trackIndex: number;
            sourceWidth: number;
            sourceHeight: number;
            /**
             * Called as thumbnails land, so a watching client can be told there
             * is more to fetch instead of guessing on a timer; `complete` is
             * true on the one report made after the final VTT is written. Only
             * invoked for a generation this call actually starts — a cache hit
             * has nothing to report.
             */
            onProgress?: (thumbCount: number, complete?: boolean) => void;
        }
    ): Promise<PreviewThumbnails | null> {
        const dir = this.previewDir(sessionId);
        // generateIndividualThumbs writes into <outputDir>/thumbnails. The
        // finished VTT lands there too — looking for it one level up meant the
        // cache never hit, and every request after the first started another
        // full pass.
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
            const run = this.generateIndividualThumbs({
                inputPath: opts.inputPath,
                outputDir: dir,
                duration: opts.duration,
                trackIndex: opts.trackIndex,
                sourceWidth: opts.sourceWidth,
                sourceHeight: opts.sourceHeight,
                onProgress: opts.onProgress,
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

        // Deliberately not awaited. Sampling an hour of video takes a while, and
        // waiting for the last frame held the request open for all of it — the
        // timeline stayed empty with nothing to say why. Thumbs are numbered and
        // each covers a fixed span, so the ones already written make a perfectly
        // valid storyboard for the part of the timeline they cover.
        return this.partialPreview(producedDir, opts);
    }

    /** A storyboard for however much of the source has been sampled so far. */
    private async partialPreview(
        producedDir: string,
        opts: { duration: number; sourceWidth: number; sourceHeight: number }
    ): Promise<PreviewThumbnails | null> {
        const thumbs = await this.listThumbFiles(producedDir);
        if (thumbs.length === 0) return null;

        return {
            vtt: this.buildIndividualVtt(
                opts.duration,
                thumbs,
                THUMB_WIDTH,
                this.thumbHeightFor(opts.sourceWidth, opts.sourceHeight)
            ),
            dir: producedDir,
            complete: false,
        };
    }

    /** The individual thumbs on disk, in sampling order. */
    private async listThumbFiles(dir: string): Promise<string[]> {
        try {
            return (await readdir(dir))
                .filter((f) => THUMB_FILE_RE.test(f))
                .sort();
        } catch {
            return []; // Nothing written yet.
        }
    }

    /** Thumbnail height for the source's aspect ratio, kept even for the encoders. */
    private thumbHeightFor(sourceWidth: number, sourceHeight: number): number {
        return Math.ceil(((THUMB_WIDTH / sourceWidth) * sourceHeight) / 2) * 2;
    }

    private async detectSpriteFormat(): Promise<SpriteFormat | null> {
        if (this.spriteFormat !== undefined) return this.spriteFormat;
        try {
            const { stdout } = await execFileAsync(ffmpegBin(), ['-encoders'], {
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
     * integer, so the pass died before ffmpeg was even started.
     */
    private timeoutFor(durationSeconds: number): number {
        const scaled = (durationSeconds / 4) * 1000;
        return Math.round(Math.min(Math.max(scaled, 300_000), 1_800_000));
    }

    /**
     * Sample the source into individual thumbnails, one every INTERVAL_SECONDS.
     *
     * Deliberately software-decoded on every platform. `-hwaccel videotoolbox`
     * without `-hwaccel_output_format` was measured at 337s against 13.9s in
     * software on the same 55-minute file, for byte-identical images: the filter
     * chain scales in software, so every decoded frame is read back from the GPU
     * at roughly 2ms a frame, and the readback costs far more than the decode
     * saves. Worse, VideoToolbox logged "hardware accelerator failed to decode
     * picture" per frame and still exited 0, so the software-retry guard that
     * used to sit here never fired — a silent failure mode a retry cannot catch.
     * CUDA is unmeasured but is the same class of arrangement, so it goes too.
     */
    async generateIndividualThumbs(opts: {
        inputPath: string;
        outputDir: string;
        duration: number;
        trackIndex: number;
        sourceWidth: number;
        sourceHeight: number;
        /**
         * Reports how many thumbnails exist on disk, whenever that number
         * changes. ffmpeg says nothing useful about its own progress here, so
         * the directory listing is the measurement: it is what the partial VTT
         * is built from, which makes it exactly the signal a client needs to
         * decide there is something new to fetch.
         *
         * `complete` is true exactly once, after the final VTT is on disk. It
         * has to be its own flag: the last watcher tick usually reports the
         * full count already, and a completion report carrying the same number
         * would not read as a change on the other end.
         */
        onProgress?: (thumbCount: number, complete?: boolean) => void;
    }): Promise<ThumbnailResult | null> {
        const format = await this.detectSpriteFormat();
        if (!format) return null;
        if (opts.duration <= 0) return null;

        const thumbHeight = this.thumbHeightFor(
            opts.sourceWidth,
            opts.sourceHeight
        );

        const thumbnailDir = join(opts.outputDir, 'thumbnails');
        await mkdir(thumbnailDir, { recursive: true });

        // %06d, not %03d: an hour of source is 720 thumbs at one per five
        // seconds, and a three-digit counter wraps long before that.
        const thumbPattern = join(thumbnailDir, `thumb_%06d.${format.ext}`);

        const args = [
            '-i',
            opts.inputPath,
            '-map',
            `0:v:${opts.trackIndex}`,
            '-vf',
            `fps=1/${INTERVAL_SECONDS},scale=${THUMB_WIDTH}:${thumbHeight}`,
            '-c:v',
            format.encoder,
            ...format.args,
            '-an',
            thumbPattern,
        ];

        // Watch the directory fill while ffmpeg runs. `stopped` exists because
        // the listing is async: a tick can be mid-readdir when the interval is
        // cleared, and reporting a count after the final one below would walk
        // the client's progress backwards.
        let stopped = false;
        // Zero is the state before the pass wrote anything, so it is the one
        // count worth staying quiet about — reporting it would wake a client up
        // to fetch a storyboard that is still empty.
        let reported = 0;
        const watcher = opts.onProgress
            ? setInterval(() => {
                  void this.listThumbFiles(thumbnailDir)
                      .then((files) => {
                          if (stopped || files.length === reported) return;
                          reported = files.length;
                          opts.onProgress!(reported);
                      })
                      // A caller's callback throwing is its problem, not a
                      // reason to abandon a generation pass that is working.
                      .catch(() => {});
              }, 1000)
            : null;

        try {
            await execFileAsync(ffmpegBin(), args, {
                timeout: this.timeoutFor(opts.duration),
            });
        } catch (err) {
            this.logger.warn(
                `FFmpeg thumbnail generation failed: ${(err as Error).message}`
            );
            return null;
        } finally {
            stopped = true;
            if (watcher) clearInterval(watcher);
        }

        const thumbFiles = await this.listThumbFiles(thumbnailDir);
        if (thumbFiles.length === 0) {
            this.logger.warn('No thumbnails were generated');
            return null;
        }

        // The VTT is the completeness marker: it exists only once the pass has
        // finished, which is what getOrGeneratePreview's cache check and the
        // X-Storyboard-Complete header both read.
        const vttContent = this.buildIndividualVtt(
            opts.duration,
            thumbFiles,
            THUMB_WIDTH,
            thumbHeight
        );
        await writeFile(
            join(thumbnailDir, 'thumbnails.vtt'),
            vttContent,
            'utf-8'
        );

        // The last word on the count, emitted after the VTT is on disk so a
        // client acting on it finds the complete storyboard rather than the
        // partial one the watcher was describing a moment ago.
        try {
            opts.onProgress?.(thumbFiles.length, true);
        } catch {
            // As above: a broken callback does not fail the generation.
        }

        this.logger.log(
            `Generated ${thumbFiles.length} thumbnail(s) from video track ${opts.trackIndex} ` +
                `(${opts.sourceWidth}x${opts.sourceHeight}) for ${Math.floor(opts.duration)}s source`
        );

        return { vttRelativePath: 'thumbnails/thumbnails.vtt' };
    }

    /**
     * Pack the ingest-time thumbs into delivered sprite sheets plus a VTT on the
     * *output* timeline, and write them into the encode's output directory.
     *
     * Nothing is decoded from the source here: the frames already exist from the
     * ingest pass, and a trimmed encode is a matter of choosing which of them to
     * lay out. Returns null when there is nothing to deliver — a source with no
     * usable video, a failed prime, no image encoder. That is not an error: the
     * output simply ships without a storyboard, exactly as before.
     */
    async packForDelivery(opts: {
        sessionId: string;
        inputPath: string;
        outputDir: string;
        sourceDuration: number;
        trimSegments?: { inSec: number; outSec: number }[];
        videoTracks?: Array<{ index: number; width: number; height: number }>;
    }): Promise<ThumbnailResult | null> {
        const format = await this.detectSpriteFormat();
        if (!format) return null;

        // An encode started while the ingest prime is still running would
        // otherwise pack a half-written set. The wait is bounded by the pass
        // itself and is visible to the user as the thumbnail phase.
        const pending = this.inFlight.get(opts.sessionId);
        if (pending) {
            try {
                await pending;
            } catch {
                // Its own catch already logged; the listing below decides.
            }
        }

        const track = selectStoryboardTrack(opts.videoTracks);
        const sourceDir = join(this.previewDir(opts.sessionId), 'thumbnails');
        let thumbFiles = await this.listThumbFiles(sourceDir);

        // No thumb_* files covers both "the prime never ran" and "this session
        // was restored from before individual thumbs existed, so the cache holds
        // sprite_* sheets" — a filename check, no VTT parsing. Either way the
        // cache is unusable: throw it out and sample again.
        if (thumbFiles.length === 0) {
            if (!track || opts.sourceDuration <= 0) {
                this.logger.warn(
                    `No thumbnails to pack for ${opts.sessionId} and no usable video track to regenerate from`
                );
                return null;
            }
            this.logger.log(
                `No individual thumbnails cached for ${opts.sessionId} — regenerating before packing`
            );
            await rm(this.previewDir(opts.sessionId), {
                recursive: true,
                force: true,
            });
            const regenerated = await this.generateIndividualThumbs({
                inputPath: opts.inputPath,
                outputDir: this.previewDir(opts.sessionId),
                duration: opts.sourceDuration,
                trackIndex: track.index,
                sourceWidth: track.width,
                sourceHeight: track.height,
            });
            if (!regenerated) return null;
            thumbFiles = await this.listThumbFiles(sourceDir);
            if (thumbFiles.length === 0) return null;
        }

        if (!track) {
            // The dims decide the VTT geometry, and guessing them puts the
            // client's crop rectangles in the wrong place — better no storyboard
            // than a misaligned one.
            this.logger.warn(
                `Cannot pack thumbnails for ${opts.sessionId}: no usable video track dimensions`
            );
            return null;
        }
        const thumbHeight = this.thumbHeightFor(track.width, track.height);

        const ranges = orderedRanges(opts.trimSegments ?? []);
        const outDuration = ranges.length
            ? ranges.reduce((sum, r) => sum + (r.outSec - r.inSec), 0)
            : opts.sourceDuration;
        if (outDuration <= 0) return null;

        const selected = this.selectThumbsForOutput(
            thumbFiles,
            outDuration,
            ranges
        );
        if (selected.length === 0) return null;

        const thumbnailDir = join(opts.outputDir, 'thumbnails');
        await mkdir(thumbnailDir, { recursive: true });

        // Packed through the concat demuxer rather than a glob or an image2
        // sequence: the selection has gaps (trimmed material) and duplicates (a
        // kept range shorter than the sampling interval reuses a frame), neither
        // of which a numbered-sequence input can express. It also names every
        // file outright, so there is no shell glob to be unavailable on Windows.
        const listPath = join(thumbnailDir, 'pack-list.txt');
        await writeFile(
            listPath,
            selected
                .map((f) => `file '${concatEscape(join(sourceDir, f))}'`)
                .join('\n') + '\n',
            'utf-8'
        );

        const spritePattern = join(thumbnailDir, `sprite_%03d.${format.ext}`);
        try {
            await execFileAsync(
                ffmpegBin(),
                [
                    '-f',
                    'concat',
                    '-safe',
                    '0',
                    '-i',
                    listPath,
                    '-vf',
                    `tile=${COLUMNS}x${ROWS}`,
                    '-c:v',
                    format.encoder,
                    ...format.args,
                    '-an',
                    spritePattern,
                ],
                // Fixed budget: this only ever re-encodes a few hundred 160px
                // images, with no source decode in sight.
                { timeout: 60_000 }
            );
        } catch (err) {
            this.logger.warn(
                `Thumbnail packing failed for ${opts.sessionId}: ${(err as Error).message}`
            );
            return null;
        } finally {
            await rm(listPath, { force: true });
        }

        const spriteFiles = (await readdir(thumbnailDir))
            .filter(
                (f) => f.startsWith('sprite_') && f.endsWith(`.${format.ext}`)
            )
            .sort();
        if (spriteFiles.length === 0) {
            this.logger.warn(
                `No sprite sheets were produced for ${opts.sessionId}`
            );
            return null;
        }

        // The packed thumbs are a uniform grid on the output timeline, which is
        // exactly the shape buildVtt already assumes.
        const vttContent = this.buildVtt(
            outDuration,
            spriteFiles,
            THUMB_WIDTH,
            thumbHeight
        );
        await writeFile(
            join(thumbnailDir, 'thumbnails.vtt'),
            vttContent,
            'utf-8'
        );

        this.logger.log(
            `Packed ${selected.length} thumbnail(s) into ${spriteFiles.length} sprite sheet(s) ` +
                `for ${Math.floor(outDuration)}s of output`
        );

        return { vttRelativePath: 'thumbnails/thumbnails.vtt' };
    }

    /**
     * One source thumbnail per output cue.
     *
     * Chosen on the output grid rather than by filtering the source grid: the
     * output VTT has to have a cue for every five seconds of programme, and a
     * kept range shorter than the sampling interval contains no sampled instant
     * at all — filtering would silently drop it.
     *
     * The clamp is the part that matters. `floor(tSrc / 5)` alone can name a
     * thumb sampled up to five seconds *before* the cut-in, which is material
     * the user deleted; bounding the index by the kept range it falls in makes
     * that impossible. A range too short to contain a sample instant has its
     * bounds cross, and the cut-in side wins: a frame from just inside the
     * neighbouring bucket is a small inaccuracy, a frame from deleted material
     * is a bug.
     */
    private selectThumbsForOutput(
        thumbFiles: string[],
        outDuration: number,
        ranges: KeptRange[]
    ): string[] {
        const selected: string[] = [];
        const cues = Math.ceil(outDuration / INTERVAL_SECONDS);

        for (let j = 0; j < cues; j++) {
            // The cue midpoint, so a frame is picked from the middle of what the
            // cue covers rather than from its very edge.
            const tOut = Math.min(
                j * INTERVAL_SECONDS + INTERVAL_SECONDS / 2,
                Math.max(0, outDuration - 0.001)
            );
            const { tSrc, range } = outputToSource(tOut, ranges);

            let idx = Math.floor(tSrc / INTERVAL_SECONDS);
            if (range) {
                const lo = Math.ceil(range.inSec / INTERVAL_SECONDS);
                const hi = Math.floor(range.outSec / INTERVAL_SECONDS);
                idx = lo > hi ? lo : Math.min(Math.max(idx, lo), hi);
            }
            idx = Math.min(Math.max(idx, 0), thumbFiles.length - 1);

            selected.push(thumbFiles[idx]!);
        }

        return selected;
    }

    /**
     * VTT over individual thumbnails: each cue is a whole image, so the crop
     * rectangle is the full frame. Clients render `#xywh` the same way either
     * way, so nothing downstream has to know which kind of storyboard it has.
     */
    buildIndividualVtt(
        duration: number,
        thumbFiles: string[],
        thumbWidth: number,
        thumbHeight: number
    ): string {
        const total = Math.min(
            Math.ceil(duration / INTERVAL_SECONDS),
            thumbFiles.length
        );
        const lines: string[] = ['WEBVTT', ''];

        for (let i = 0; i < total; i++) {
            const startTime = i * INTERVAL_SECONDS;
            const endTime = Math.min((i + 1) * INTERVAL_SECONDS, duration);

            lines.push(
                `${formatVttTime(startTime)} --> ${formatVttTime(endTime)}`
            );
            lines.push(
                `${thumbFiles[i]}#xywh=0,0,${thumbWidth},${thumbHeight}`
            );
            lines.push('');
        }

        return lines.join('\n');
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

// ---------------------------------------------------------------------------
// Source <-> output mapping
//
// A server-side twin of app/src/utils/trimTimeline.ts (ordered/outputToSource).
// The api workspace cannot import from app, and the two have to agree: the
// client draws the trim timeline with that walk, and this one decides which
// frame the delivered storyboard shows for the same instant. Kept deliberately
// line-for-line comparable — change one, change the other.
// ---------------------------------------------------------------------------

/** Ranges sorted, with anything degenerate dropped. */
function orderedRanges(ranges: readonly KeptRange[]): KeptRange[] {
    return ranges
        .filter((r) => r.outSec > r.inSec)
        .slice()
        .sort((a, b) => a.inSec - b.inSec);
}

/**
 * Where an output position sits in the source file, plus the kept range it
 * landed in — the client twin returns only the position, but the packer needs
 * the range to keep its thumb index out of deleted material.
 */
function outputToSource(
    t: number,
    ranges: readonly KeptRange[]
): { tSrc: number; range: KeptRange | null } {
    if (ranges.length === 0) return { tSrc: t, range: null };
    let remaining = Math.max(0, t);
    for (const r of ranges) {
        const length = r.outSec - r.inSec;
        if (remaining < length) return { tSrc: r.inSec + remaining, range: r };
        remaining -= length;
    }
    const last = ranges[ranges.length - 1]!;
    return { tSrc: last.outSec, range: last };
}

/**
 * Escape a path for a concat demuxer `file '...'` line. Paths here are ours and
 * quote-free in practice, but a single quote in a session path would otherwise
 * end the string and hand ffmpeg a filename it cannot open.
 */
function concatEscape(path: string): string {
    return path.replace(/'/g, `'\\''`);
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
