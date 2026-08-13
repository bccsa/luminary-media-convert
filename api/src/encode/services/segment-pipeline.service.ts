import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, createWriteStream, type WriteStream } from 'fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
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

/**
 * How much of a chain's content the first chunk of that chain carries, in
 * seconds of timeline per stream.
 *
 * The first chunk is the one a viewer waits on before anything plays, so it is
 * deliberately small: the edge warms almost immediately at play-start, and
 * somebody who watches ten seconds and leaves has not dragged a full-size
 * backhaul across for it. Every chunk after it is grown to the cap instead,
 * because each extra object is a billed storage operation and a permanent cache
 * entry — and intermediate ramp steps buy nothing once ranges pass straight
 * through to the client, which is the property this whole layout assumes.
 */
const FIRST_CHUNK_SECONDS = 20;

/**
 * Default cap for the audio chain. Smaller than the video cap because the audio
 * chain carries every audio rendition at once and is fetched by every viewer,
 * including audio-only ones, so its backhaul wants to stay quick.
 */
const DEFAULT_AUDIO_CHUNK_CAP_BYTES = 50 * 1024 * 1024;

export interface SegmentPipelineConfig {
    outputDir: string;
    s3Config: S3ConfigDto;
    s3PathPrefix: string;
    encryptionKey?: Buffer;
    encryptionIV?: Buffer;
    byteRange: boolean;
    byteRangeMaxFileSizeBytes: number;
    /**
     * Stream directory name → chunk chain id, as `FfmpegService`
     * .buildStreamChainMap` computed it from the encode config. Absent, or
     * missing an entry, means that directory packs into a chain of its own —
     * the pre-shared-chain behaviour, which is a worse layout but never a
     * failed encode.
     */
    streamChains?: Record<string, string>;
    /** Cap for the audio chain. Defaults to 50 MiB. */
    audioByteRangeMaxFileSizeBytes?: number;
    /** Segment duration the encode was configured with. Defaults to 6. */
    segmentDurationSeconds?: number;
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

/**
 * One chunk chain: a run of `<id>_<n>.m4s` files under `media/`, shared by every
 * stream mapped to it.
 *
 * Byte order inside a chunk does not matter — an edge asked for a range pulls
 * the whole object anyway — so segments land in whatever order they arrive and
 * nothing waits for a peer stream to catch up.
 */
interface ChainState {
    id: string;
    capBytes: number;
    /** How many stream directories pack into this chain. */
    streamCount: number;
    currentChunkIndex: number;
    currentChunkOffset: number;
    currentChunkStream: WriteStream | null;
    currentChunkFile: string;
    currentChunkSegmentCount: number;
}

interface StreamState {
    processedSegments: Set<string>;
    /**
     * This stream's own view of the chain: playlist-ordered, so the positional
     * `#EXTINF` backfill still lines up even though the chunk these point into
     * is shared with other streams.
     */
    byteRangeEntries: ByteRangeEntry[];
    chain: ChainState;
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
    private readonly chains = new Map<string, ChainState>();
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

        // Close the last chunk of every chain and enqueue it. Chains, not
        // streams: several streams share one open chunk file, and closing it
        // once per stream would enqueue the same object several times over.
        if (this.config.byteRange) {
            for (const chain of this.chains.values()) {
                await this.finalizeCurrentChunk(chain);
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
        for (const chain of this.chains.values()) {
            if (chain.currentChunkStream) {
                chain.currentChunkStream.end();
                chain.currentChunkStream = null;
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

        // Sequential, under the reentrancy guard `start()` holds, and every
        // append below is awaited. That is the whole of the concurrency story
        // for a shared chain: two streams can never be writing into the same
        // chunk file at once, so no lock is needed to keep their bytes — and
        // the offsets recorded against them — from interleaving.
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
                byteRangeEntries: [],
                chain: this.chainFor(streamDirName),
            };
            this.streamStates.set(streamDir, state);
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

        // The fMP4 init (`init.mp4`, or `init_<variant>.mp4` on FFmpeg 8) is
        // deliberately NOT uploaded here. FFmpeg creates the file empty at
        // muxer start and fills it moments later, and an upload on first
        // sight races that write — this pipeline shipped four zero-byte inits
        // that way, and the `uploadedKeys` dedup then refused to send the
        // finished file behind them, so playback got an init with no moov and
        // a black frame. Nothing can play from S3 before the encode
        // completes anyway, so the init loses nothing by travelling with the
        // remaining files at the end, complete by construction.

        const segmentFiles = files
            .filter((f) => f.startsWith('segment_') && f.endsWith('.m4s'))
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

    /**
     * The chain a stream directory packs into, created on first sight.
     *
     * An unmapped directory is not an error worth failing an encode over: it
     * gets a chain to itself, which is exactly the per-stream layout this
     * replaced. It is logged because the mapping is built from the same config
     * the directory names are, so a miss means the two have drifted apart.
     */
    private chainFor(streamDirName: string): ChainState {
        const mapped = this.config.streamChains?.[streamDirName];
        if (!mapped) {
            this.logger.warn(
                `[pipeline] ${streamDirName}: no chunk chain configured — packing it into a chain of its own`
            );
        }

        const id = mapped ?? streamDirName;
        const existing = this.chains.get(id);
        if (existing) return existing;

        const streamCount = mapped
            ? Object.values(this.config.streamChains ?? {}).filter(
                  (v) => v === id
              ).length
            : 1;

        const chain: ChainState = {
            id,
            capBytes:
                id === 'a'
                    ? (this.config.audioByteRangeMaxFileSizeBytes ??
                      DEFAULT_AUDIO_CHUNK_CAP_BYTES)
                    : this.config.byteRangeMaxFileSizeBytes,
            streamCount: Math.max(1, streamCount),
            currentChunkIndex: 0,
            currentChunkOffset: 0,
            currentChunkStream: null,
            currentChunkFile: '',
            currentChunkSegmentCount: 0,
        };
        this.chains.set(id, chain);
        return chain;
    }

    /** Where the chunk chains are written, one directory for all of them. */
    private get chunkDir(): string {
        return join(this.config.outputDir, 'media');
    }

    /**
     * How many segments close chunk 0 of a chain.
     *
     * `FIRST_CHUNK_SECONDS` of timeline, counted across every stream in the
     * chain — so a chain of three renditions closes after three renditions'
     * worth of that stretch, not after a third of it.
     */
    private firstChunkSegmentTarget(chain: ChainState): number {
        const segmentDuration = this.config.segmentDurationSeconds ?? 6;
        return (
            chain.streamCount * Math.ceil(FIRST_CHUNK_SECONDS / segmentDuration)
        );
    }

    private async appendToByteRangeChunk(
        state: StreamState,
        seg: { extinfLine: string; filename: string },
        segPath: string
    ): Promise<void> {
        const chain = state.chain;

        // Get segment size
        const segStat = await stat(segPath);
        const segSize = segStat.size;
        if (segSize === 0) return;

        if (segSize > chain.capBytes) {
            // Said out loud because the consequence is silent: the chunk this
            // lands in is larger than the cap, and an object over the edge's
            // cacheable maximum is not cached at all. Nothing errors, playback
            // works, and every request goes to origin for good.
            this.logger.warn(
                `[pipeline] chain ${chain.id}: segment ${seg.filename} is ${segSize} bytes, ` +
                    `over the ${chain.capBytes}-byte chunk cap on its own — its chunk will exceed the cap`
            );
        }

        // Roll on the byte cap.
        if (
            chain.currentChunkOffset > 0 &&
            chain.currentChunkOffset + segSize > chain.capBytes
        ) {
            await this.finalizeCurrentChunk(chain);
        }

        // Ensure we have an open write stream
        if (!chain.currentChunkStream) {
            await mkdir(this.chunkDir, { recursive: true });
            chain.currentChunkFile = `${chain.id}_${chain.currentChunkIndex}.m4s`;
            chain.currentChunkStream = createWriteStream(
                join(this.chunkDir, chain.currentChunkFile)
            );
            chain.currentChunkStream.setMaxListeners(0);
        }

        // Append segment to chunk
        await pipeline(createReadStream(segPath), chain.currentChunkStream, {
            end: false,
        });

        state.byteRangeEntries.push({
            extinfLine: seg.extinfLine,
            length: segSize,
            offset: chain.currentChunkOffset,
            mediaFile: chain.currentChunkFile,
        });
        chain.currentChunkOffset += segSize;
        chain.currentChunkSegmentCount++;

        // Delete the original segment file (data now in chunk)
        await unlink(segPath).catch(() => {});

        // And roll chunk 0 on its segment count, which is the only chunk that
        // closes on anything but the byte cap. Checked after the append so the
        // segment that reaches the target is inside the chunk rather than
        // starting the next one.
        if (
            chain.currentChunkIndex === 0 &&
            chain.currentChunkSegmentCount >=
                this.firstChunkSegmentTarget(chain)
        ) {
            await this.finalizeCurrentChunk(chain);
        }
    }

    /**
     * Close the chain's open chunk, hand it to the upload queue and move the
     * chain on to the next index. A chain with nothing open is a no-op, which
     * is what makes calling this from `drain()` for every chain safe.
     */
    private async finalizeCurrentChunk(chain: ChainState): Promise<void> {
        if (!chain.currentChunkStream) return;

        chain.currentChunkStream.end();
        await new Promise<void>((resolve) =>
            chain.currentChunkStream!.on('finish', resolve)
        );
        chain.currentChunkStream = null;

        this.logger.log(
            `[pipeline] chain ${chain.id}: chunk ${chain.currentChunkFile} closed ` +
                `(${chain.currentChunkOffset} bytes, ${chain.currentChunkSegmentCount} segments)`
        );

        this.enqueueUpload({
            filePath: join(this.chunkDir, chain.currentChunkFile),
            objectKey: this.chainObjectKey(chain.currentChunkFile),
            deleteAfterUpload: true,
            // Spans streams now, which the progress counter does not mind: it
            // counts segments uploaded, not segments of any one stream.
            segmentCount: chain.currentChunkSegmentCount,
        });

        chain.currentChunkIndex++;
        chain.currentChunkOffset = 0;
        chain.currentChunkSegmentCount = 0;
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

        // The above won't match because mediaFile is a chunk name ('v0_0.m4s')
        // not 'segment_00000.m4s'. Match by order: entries are in the same
        // order as segments in the playlist — which stays true with a shared
        // chain, because these entries are this stream's alone.
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
            // The playlist stays in its own stream directory; the chunk it
            // points into is shared, so it lives one level up under `media/`.
            // `#EXT-X-MAP` is untouched — the init is per stream and stays put.
            newLines.push(`../media/${br.mediaFile}`);
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

    /** Chunk chains sit beside the stream directories, not inside one. */
    private chainObjectKey(filename: string): string {
        return this.objectKey('media', filename);
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
