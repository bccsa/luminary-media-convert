import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, createWriteStream, type WriteStream } from 'fs';
import { readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join, relative, posix } from 'path';
import type * as Minio from 'minio';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';
import { EncryptionService } from './encryption.service.js';
import { S3Service } from './s3.service.js';

/**
 * Work that happens after the segment pipeline has drained, before the status
 * leaves `encoding` — and the remaining-files upload that follows it.
 *
 * Draining at 100% is not the encode finishing. Playlist key tags, the
 * thumbnail sprites, the waveform sidecar and text-asset encryption all still
 * have to run, and then the playlists and sprites still have to be uploaded.
 * Reporting none of it left a finished-looking bar sitting over unfinished
 * work, which reads as stalled rather than busy.
 *
 * Identifiers rather than sentences: the client owns the wording, and one it
 * does not recognise renders nothing, so an older client against a newer API
 * degrades quietly instead of printing a raw key at the user.
 */
export type PipelinePhase =
    | 'encoding'
    | 'draining'
    | 'finalising-playlists'
    | 'thumbnails'
    | 'waveform'
    | 'encrypting-playlists'
    | 'uploading-playlists';

export interface PipelineProgress {
    encoding: number;
    encrypting?: number;
    uploading?: number;
    /**
     * What is happening now. Absent means the segment pipeline is still the
     * whole story, which is what every caller assumed before this existed.
     */
    phase?: PipelinePhase;
}

export interface SegmentPipelineConfig {
    outputDir: string;
    s3Config: S3ConfigDto;
    s3PathPrefix: string;
    encryptionKey?: Buffer;
    encryptionIV?: Buffer;
    byteRange: boolean;
    byteRangeMaxFileSizeBytes: number;
    /** Estimated total segments across all streams (for progress calculation) */
    estimatedTotalSegments?: number;
    pollIntervalMs?: number;
    uploadConcurrency?: number;
    onProgress?: (progress: PipelineProgress) => void;
}

interface ByteRangeEntry {
    extinfLine: string;
    length: number;
    offset: number;
    mediaFile: string;
}

interface StreamState {
    processedSegments: Set<string>;
    initUploaded: boolean;
    currentChunkIndex: number;
    currentChunkOffset: number;
    currentChunkStream: WriteStream | null;
    currentChunkMediaFile: string;
    currentChunkSegmentCount: number;
    byteRangeEntries: ByteRangeEntry[];
    segExt: string;
}

interface UploadTask {
    filePath: string;
    objectKey: string;
    deleteAfterUpload: boolean;
    /** Number of segments this upload represents (for byte-range chunks) */
    segmentCount?: number;
}

@Injectable()
export class SegmentPipelineService {
    private readonly logger = new Logger(SegmentPipelineService.name);

    constructor(
        private readonly encryptionService: EncryptionService,
        private readonly s3Service: S3Service
    ) {}

    /**
     * Create a pipeline instance for a specific encoding session.
     */
    createPipeline(config: SegmentPipelineConfig): SegmentPipeline {
        return new SegmentPipeline(
            config,
            this.encryptionService,
            this.s3Service,
            this.logger
        );
    }
}

export class SegmentPipeline {
    private readonly pollIntervalMs: number;
    private readonly uploadConcurrency: number;
    private readonly streamStates = new Map<string, StreamState>();
    private readonly uploadedKeys: string[] = [];

    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private polling = false;
    private aborted = false;
    private s3Client: Minio.Client;
    private pipelineError: Error | null = null;

    // Counters for progress reporting
    private totalSegmentsProduced = 0;
    private segmentsEncrypted = 0;
    private segmentsUploaded = 0;
    /** Bytes handed to S3, counted as they are sent rather than on completion. */
    private bytesUploaded = 0;

    // Upload queue
    private readonly uploadQueue: UploadTask[] = [];
    private activeUploads = 0;
    /**
     * Silences the segment-oriented progress emitter while `uploadRemainingFiles`
     * runs. That method reports its own per-file figure; leaving `emitProgress()`
     * live would have `executeUpload` interleave the segment-based `uploading:
     * 100` with it after every file and the bar would jitter between the two.
     */
    private suppressProgressEvents = false;

    constructor(
        private readonly config: SegmentPipelineConfig,
        private readonly encryptionService: EncryptionService,
        private readonly s3Service: S3Service,
        private readonly logger: Logger
    ) {
        this.pollIntervalMs = config.pollIntervalMs ?? 2000;
        this.uploadConcurrency = config.uploadConcurrency ?? 5;
        this.s3Client = this.s3Service.createClient(config.s3Config);
    }

    get error(): Error | null {
        return this.pipelineError;
    }

    get keys(): string[] {
        return [...this.uploadedKeys];
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.pollTimer = setInterval(() => {
            if (this.polling) return; // Skip if previous poll is still running
            this.polling = true;
            this.poll()
                .catch((err) => {
                    this.pipelineError = err;
                    this.logger.error(
                        `Pipeline poll error: ${(err as Error).message}`
                    );
                })
                .finally(() => {
                    this.polling = false;
                });
        }, this.pollIntervalMs);
    }

    async drain(): Promise<string[]> {
        // Stop polling and wait for any in-flight poll to complete
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        while (this.polling) {
            await new Promise((r) => setTimeout(r, 50));
        }

        if (this.pipelineError) throw this.pipelineError;

        // Final sweep to catch any remaining segments
        await this.poll();

        if (this.pipelineError) throw this.pipelineError;

        // Finalize all byte-range chunk streams and enqueue for upload
        if (this.config.byteRange) {
            for (const [streamDir, state] of this.streamStates) {
                if (state.currentChunkStream) {
                    await this.finalizeCurrentChunk(streamDir, state);
                    // Enqueue the finalized last chunk for upload
                    const streamDirName = relative(
                        this.config.outputDir,
                        streamDir
                    );
                    const objectKey = this.objectKey(
                        streamDirName,
                        state.currentChunkMediaFile
                    );
                    this.enqueueUpload({
                        filePath: join(streamDir, state.currentChunkMediaFile),
                        objectKey,
                        deleteAfterUpload: true,
                        segmentCount: state.currentChunkSegmentCount,
                    });
                }
            }
        }

        // Wait for all uploads to complete
        await this.waitForUploads();

        if (this.pipelineError) throw this.pipelineError;

        // Rewrite playlists with byte-range entries
        if (this.config.byteRange) {
            // Backfill #EXTINF lines from the now-complete playlist
            for (const [streamDir, state] of this.streamStates) {
                await this.backfillExtinfLines(streamDir, state);
                await this.rewritePlaylistWithByteRanges(streamDir, state);
            }
        }

        this.running = false;
        return [...this.uploadedKeys];
    }

    abort(): void {
        this.aborted = true;
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        // Close any open chunk streams
        for (const state of this.streamStates.values()) {
            if (state.currentChunkStream) {
                state.currentChunkStream.end();
                state.currentChunkStream = null;
            }
        }
    }

    private async poll(): Promise<void> {
        if (this.aborted || this.pipelineError) return;

        const { outputDir } = this.config;

        let entries;
        try {
            entries = await readdir(outputDir, { withFileTypes: true });
        } catch {
            // Output dir may not exist yet at the start of encoding
            return;
        }

        const streamDirs = entries
            .filter((e) => e.isDirectory() && e.name.startsWith('stream_'))
            .map((e) => e.name)
            .sort();

        for (const dir of streamDirs) {
            if (this.aborted || this.pipelineError) return;
            await this.processStream(dir);
        }
    }

    private async processStream(streamDirName: string): Promise<void> {
        const streamDir = join(this.config.outputDir, streamDirName);
        let state = this.streamStates.get(streamDir);

        if (!state) {
            state = {
                processedSegments: new Set(),
                initUploaded: false,
                currentChunkIndex: 0,
                currentChunkOffset: 0,
                currentChunkStream: null,
                currentChunkMediaFile: '',
                currentChunkSegmentCount: 0,
                byteRangeEntries: [],
                segExt: 'm4s',
            };
            this.streamStates.set(streamDir, state);
        }

        // Upload init.mp4 on first encounter
        if (!state.initUploaded) {
            const initPath = join(streamDir, 'init.mp4');
            try {
                await stat(initPath);
                const objectKey = this.objectKey(streamDirName, 'init.mp4');
                this.enqueueUpload({
                    filePath: initPath,
                    objectKey,
                    deleteAfterUpload: false, // init.mp4 may be needed for playlist rewriting
                });
                state.initUploaded = true;
            } catch {
                // init.mp4 doesn't exist yet or not using fMP4
            }
        }

        // Discover segments from disk (not from playlist — FFmpeg with
        // -hls_playlist_type vod only writes the playlist at the end).
        // Scan for segment files that FFmpeg writes as encoding progresses.
        let files: string[];
        try {
            files = await readdir(streamDir);
        } catch {
            return;
        }

        const segmentFiles = files
            .filter(
                (f) =>
                    f.startsWith('segment_') &&
                    (f.endsWith('.m4s') || f.endsWith('.ts'))
            )
            .filter((f) => !state.processedSegments.has(f))
            .sort();

        if (segmentFiles.length > 0) {
            this.logger.debug(
                `[pipeline] ${streamDirName}: found ${segmentFiles.length} new segment(s) (processed: ${state.processedSegments.size})`
            );
        }

        for (const filename of segmentFiles) {
            if (this.aborted || this.pipelineError) return;

            const segPath = join(streamDir, filename);

            // Verify the file is complete (non-zero size)
            try {
                const s = await stat(segPath);
                if (s.size === 0) continue;
            } catch {
                continue;
            }

            state.processedSegments.add(filename);
            this.totalSegmentsProduced++;

            // Detect segment extension from first segment
            if (filename.endsWith('.ts')) {
                state.segExt = 'ts';
            }

            // Encrypt if needed
            if (this.config.encryptionKey && this.config.encryptionIV) {
                try {
                    await this.encryptionService.encryptSegment(
                        segPath,
                        this.config.encryptionKey,
                        this.config.encryptionIV
                    );
                    this.segmentsEncrypted++;
                } catch (err) {
                    this.pipelineError = new Error(
                        `Segment encryption failed for ${filename}: ${(err as Error).message}`
                    );
                    return;
                }
            }

            if (this.config.byteRange) {
                await this.appendToByteRangeChunk(
                    streamDir,
                    streamDirName,
                    state,
                    { extinfLine: '', filename },
                    segPath
                );
            } else {
                // Upload individual segment
                const objectKey = this.objectKey(streamDirName, filename);
                this.enqueueUpload({
                    filePath: segPath,
                    objectKey,
                    deleteAfterUpload: true,
                });
            }

            this.emitProgress();
        }
    }

    private async appendToByteRangeChunk(
        streamDir: string,
        streamDirName: string,
        state: StreamState,
        seg: { extinfLine: string; filename: string },
        segPath: string
    ): Promise<void> {
        // Get segment size
        const segStat = await stat(segPath);
        const segSize = segStat.size;
        if (segSize === 0) return;

        // Check if we need to start a new chunk
        if (
            state.currentChunkOffset > 0 &&
            state.currentChunkOffset + segSize >
                this.config.byteRangeMaxFileSizeBytes
        ) {
            // Finalize current chunk — close stream and enqueue for upload
            await this.finalizeCurrentChunk(streamDir, state);

            // Enqueue the completed chunk for upload
            const completedChunkFile = state.currentChunkMediaFile;
            const objectKey = this.objectKey(streamDirName, completedChunkFile);
            this.enqueueUpload({
                filePath: join(streamDir, completedChunkFile),
                objectKey,
                deleteAfterUpload: true,
                segmentCount: state.currentChunkSegmentCount,
            });

            // Start a new chunk
            state.currentChunkIndex++;
            state.currentChunkOffset = 0;
            state.currentChunkSegmentCount = 0;
        }

        // Ensure we have an open write stream
        if (!state.currentChunkStream) {
            state.currentChunkMediaFile = `media_${state.currentChunkIndex}.${state.segExt}`;
            state.currentChunkStream = createWriteStream(
                join(streamDir, state.currentChunkMediaFile)
            );
            state.currentChunkStream.setMaxListeners(0);
        }

        // Append segment to chunk
        await pipeline(createReadStream(segPath), state.currentChunkStream, {
            end: false,
        });

        state.byteRangeEntries.push({
            extinfLine: seg.extinfLine,
            length: segSize,
            offset: state.currentChunkOffset,
            mediaFile: state.currentChunkMediaFile,
        });
        state.currentChunkOffset += segSize;
        state.currentChunkSegmentCount++;

        // Delete the original segment file (data now in chunk)
        await unlink(segPath).catch(() => {});
    }

    private async finalizeCurrentChunk(
        streamDir: string,
        state: StreamState
    ): Promise<void> {
        if (!state.currentChunkStream) return;

        state.currentChunkStream.end();
        await new Promise<void>((resolve) =>
            state.currentChunkStream!.on('finish', resolve)
        );
        state.currentChunkStream = null;
    }

    /**
     * Read the now-complete playlist and fill in empty extinfLine values
     * in byteRangeEntries. During encoding, segments are discovered from
     * disk before the playlist exists, so extinfLine is stored as ''.
     */
    private async backfillExtinfLines(
        streamDir: string,
        state: StreamState
    ): Promise<void> {
        const playlistPath = join(streamDir, 'playlist.m3u8');
        let content: string;
        try {
            content = await readFile(playlistPath, 'utf-8');
        } catch {
            return;
        }

        // Build a map: segment filename → #EXTINF line
        const extinfMap = new Map<string, string>();
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].startsWith('#EXTINF:')) {
                const filename = lines[i + 1]?.trim();
                if (filename && !filename.startsWith('#')) {
                    extinfMap.set(filename, lines[i]);
                }
            }
        }

        for (const entry of state.byteRangeEntries) {
            if (!entry.extinfLine) {
                entry.extinfLine = extinfMap.get(entry.mediaFile) ?? '';
                // mediaFile is the chunk name, but the playlist has the
                // original segment filename. Match by index instead.
            }
        }

        // The above won't match because mediaFile is 'media_0.m4s' not
        // 'segment_00000.m4s'. Match by order: entries are in the same
        // order as segments in the playlist.
        const playlistSegments = this.parseSegments(content);
        for (let i = 0; i < state.byteRangeEntries.length; i++) {
            if (!state.byteRangeEntries[i].extinfLine && playlistSegments[i]) {
                state.byteRangeEntries[i].extinfLine =
                    playlistSegments[i].extinfLine;
            }
        }
    }

    private async rewritePlaylistWithByteRanges(
        streamDir: string,
        state: StreamState
    ): Promise<void> {
        if (state.byteRangeEntries.length === 0) return;

        const playlistPath = join(streamDir, 'playlist.m3u8');
        let content: string;
        try {
            content = await readFile(playlistPath, 'utf-8');
        } catch {
            return;
        }

        const lines = content.split('\n');
        const headerLines: string[] = [];
        let footerLine = '';

        for (const line of lines) {
            if (line.startsWith('#EXTINF:')) break;
            if (line.startsWith('#EXT-X-ENDLIST')) {
                footerLine = line;
            } else {
                headerLines.push(line);
            }
        }

        // Check for ENDLIST at the end if not already captured
        if (!footerLine) {
            const lastLine = lines[lines.length - 1]?.trim();
            const secondLastLine = lines[lines.length - 2]?.trim();
            if (lastLine === '#EXT-X-ENDLIST') footerLine = lastLine;
            else if (secondLastLine === '#EXT-X-ENDLIST')
                footerLine = secondLastLine;
        }

        const newLines: string[] = [...headerLines];
        for (const br of state.byteRangeEntries) {
            newLines.push(br.extinfLine);
            newLines.push(`#EXT-X-BYTERANGE:${br.length}@${br.offset}`);
            newLines.push(br.mediaFile);
        }
        if (footerLine) newLines.push(footerLine);
        newLines.push('');

        await writeFile(playlistPath, newLines.join('\n'), 'utf-8');
    }

    private parseSegments(
        content: string
    ): { extinfLine: string; filename: string }[] {
        const segments: { extinfLine: string; filename: string }[] = [];
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('#EXTINF:')) {
                const filename = lines[i + 1]?.trim();
                if (filename && !filename.startsWith('#')) {
                    segments.push({ extinfLine: line, filename });
                    i++;
                }
            }
        }

        return segments;
    }

    private objectKey(streamDirName: string, filename: string): string {
        const relativePath = posix.join(streamDirName, filename);
        return this.config.s3PathPrefix
            ? posix.join(this.config.s3PathPrefix, relativePath)
            : relativePath;
    }

    private enqueueUpload(task: UploadTask): void {
        this.uploadQueue.push(task);
        this.processUploadQueue();
    }

    private processUploadQueue(): void {
        while (
            this.activeUploads < this.uploadConcurrency &&
            this.uploadQueue.length > 0
        ) {
            const task = this.uploadQueue.shift()!;
            this.activeUploads++;
            this.executeUpload(task)
                .then(() => {
                    this.activeUploads--;
                    this.processUploadQueue();
                })
                .catch((err) => {
                    this.activeUploads--;
                    this.pipelineError = err;
                });
        }
    }

    private async executeUpload(task: UploadTask): Promise<void> {
        let lastErr: Error | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                await this.s3Service.uploadFile(
                    this.s3Client,
                    this.config.s3Config.bucket,
                    task.filePath,
                    task.objectKey,
                    (bytes) => {
                        this.bytesUploaded += bytes;
                    }
                );
                this.uploadedKeys.push(task.objectKey);
                this.segmentsUploaded += task.segmentCount ?? 1;

                // Delete local file after confirmed upload
                if (task.deleteAfterUpload) {
                    await unlink(task.filePath).catch(() => {});
                }

                this.emitProgress();
                return;
            } catch (err) {
                lastErr = err as Error;
                if (attempt < 2) {
                    // Exponential backoff: 1s, 2s
                    await new Promise((r) =>
                        setTimeout(r, 1000 * (attempt + 1))
                    );
                }
            }
        }

        throw new Error(
            `S3 upload failed for ${task.objectKey} after 3 attempts: ${lastErr?.message}`
        );
    }

    private async waitForUploads(): Promise<void> {
        // Stall watchdog: trip only when nothing at all has moved for stallMs.
        //
        // "Moved" has to mean bytes. Watching completed uploads instead cannot
        // tell slow from stuck: byte-range packing writes files of a few hundred
        // MB, and on a slow link one of those takes longer than any sensible
        // timeout while transferring perfectly well. A 500 MB pack at 2 MB/s
        // takes over four minutes, so a five-minute completion-based detector
        // discarded a finished hour-long encode twice over — with every upload
        // succeeding and nothing logged as an error.
        const stallMs = Number(
            process.env.S3_UPLOAD_STALL_TIMEOUT_MS ?? 5 * 60 * 1000
        );

        let lastProgressAt = Date.now();
        let lastBytes = this.bytesUploaded;
        let lastUploaded = this.segmentsUploaded;
        let lastQueueDepth = this.activeUploads + this.uploadQueue.length;

        while (
            (this.activeUploads > 0 || this.uploadQueue.length > 0) &&
            !this.pipelineError
        ) {
            const queueDepth = this.activeUploads + this.uploadQueue.length;
            if (
                this.bytesUploaded !== lastBytes ||
                this.segmentsUploaded !== lastUploaded ||
                queueDepth !== lastQueueDepth
            ) {
                lastBytes = this.bytesUploaded;
                lastUploaded = this.segmentsUploaded;
                lastQueueDepth = queueDepth;
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt > stallMs) {
                const stalledSec = Math.round(stallMs / 1000);
                throw new Error(
                    `Pipeline drain stalled: no bytes sent to S3 for ${stalledSec}s ` +
                        `(active=${this.activeUploads}, queued=${this.uploadQueue.length}, ` +
                        `segments=${this.segmentsUploaded}, ` +
                        `sent=${(this.bytesUploaded / 1048576).toFixed(0)}MB)`
                );
            }
            await new Promise((r) => setTimeout(r, 200));
        }
    }

    /**
     * Upload remaining files from the output directory (playlists, thumbnails, etc.)
     * that were not handled by the segment pipeline.
     *
     * `onFileProgress` is the only progress this phase has: the segment counters
     * stopped meaning anything once drain finished, so the caller drives its own
     * bar from the file count and `emitProgress()` is suppressed throughout.
     */
    async uploadRemainingFiles(
        outputDir: string,
        opts?: {
            onFileProgress?: (uploadedCount: number, totalCount: number) => void;
        }
    ): Promise<string[]> {
        const files = await this.walkDir(outputDir);

        const tasks: UploadTask[] = [];
        for (const filePath of files) {
            // Internal build artifacts. The packer removes its own list in a
            // finally, so `pack-list.txt` is belt-and-braces — a crashed pack
            // must not put its scratch file in the delivered output.
            if (
                filePath.endsWith('/concat.txt') ||
                filePath.endsWith('/pack-list.txt')
            ) {
                continue;
            }

            const relativePath = relative(outputDir, filePath)
                .split(/[\\/]/)
                .join('/');
            const objectKey = this.config.s3PathPrefix
                ? posix.join(this.config.s3PathPrefix, relativePath)
                : relativePath;

            // Already sent during the streaming phase — every `init.mp4` is
            // uploaded with `deleteAfterUpload: false`, so it is still on disk
            // and would otherwise be uploaded a second time and land in `files`
            // twice.
            if (this.uploadedKeys.includes(objectKey)) continue;

            tasks.push({ filePath, objectKey, deleteAfterUpload: false });
        }

        const total = tasks.length;
        const additionalKeys: string[] = [];
        let done = 0;

        this.suppressProgressEvents = true;
        try {
            const worker = async (): Promise<void> => {
                for (;;) {
                    const task = tasks.shift();
                    if (!task) return;
                    // Reuses the 3-attempt retry and the `uploadedKeys` push.
                    await this.executeUpload(task);
                    additionalKeys.push(task.objectKey);
                    opts?.onFileProgress?.(++done, total);
                }
            };

            const workers = Array.from(
                { length: Math.max(1, Math.min(this.uploadConcurrency, total)) },
                () => worker()
            );
            // A failing worker rejects here and the method rejects with it, as
            // before. The other workers finish whatever they had in flight —
            // acceptable: the session is failing either way.
            await Promise.all(workers);
        } finally {
            this.suppressProgressEvents = false;
        }

        // No `uploadedKeys.push` here: `executeUpload` already pushed each key.
        return additionalKeys;
    }

    private async walkDir(dir: string): Promise<string[]> {
        const results: string[] = [];
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...(await this.walkDir(fullPath)));
            } else {
                results.push(fullPath);
            }
        }
        return results;
    }

    private emitProgress(): void {
        if (this.suppressProgressEvents) return;
        if (!this.config.onProgress) return;

        // The estimate is preferred because it does not grow mid-encode, which
        // would make the bar jump about. But it is only `streams × ceil(duration
        // / segmentDuration)`, and FFmpeg routinely produces a few more than
        // that — keyframe alignment and trim concatenation both add segments.
        // Taken as gospel it produced an upload bar reading 102%.
        //
        // Whichever is larger is the honest denominator: the estimate while it
        // holds, the real count once it has been exceeded.
        const expectedSegments = Math.max(
            this.config.estimatedTotalSegments ?? 0,
            this.totalSegmentsProduced
        );

        const progress: PipelineProgress = {
            encoding: 0, // Set externally by EncodeService via FFmpeg callback
        };

        if (this.config.encryptionKey) {
            progress.encrypting =
                expectedSegments > 0
                    ? percentOf(this.segmentsEncrypted, expectedSegments)
                    : undefined;
        }

        if (expectedSegments > 0) {
            progress.uploading = percentOf(
                this.segmentsUploaded,
                expectedSegments
            );
        }

        this.config.onProgress(progress);
    }
}

function percentOf(done: number, total: number): number {
    if (!(total > 0)) return 0;
    return Math.min(100, Math.max(0, Math.round((done / total) * 100)));
}
