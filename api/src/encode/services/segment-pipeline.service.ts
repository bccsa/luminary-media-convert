import { Injectable, Logger } from '@nestjs/common';
import { createReadStream, createWriteStream, type WriteStream } from 'fs';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join, relative, posix } from 'path';
import {
    assembleSplicedMediaPlaylist,
    buildMediaPlaylist,
    parseMediaPlaylist,
    type HlsByteRange,
} from '@luminary-media-converter/hls-core';
import type * as Minio from 'minio';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';
import { EncryptionService } from './encryption.service.js';
import {
    readBaseMediaDecodeTime,
    readTrackTimescale,
    sampleDescription,
    shiftBaseMediaDecodeTime,
} from './fmp4-timeline.js';
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
    | 'uploading-playlists'
    /** A continue uploading what the run it continues made but never uploaded. */
    | 'uploading-kept';

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
    /**
     * Which run of the encode this is, counted from 0. Chunks of a later run are
     * named apart (`<chain>_r<attempt>_<n>.m4s`), so an upload from an earlier,
     * failed run that lands late can never overwrite one of this run's chunks.
     */
    attempt?: number;
    /**
     * Told about segments once they are safely in storage: when the chunk that
     * holds them has uploaded, or, without byte ranges, the segment itself.
     * What a failed encode can continue from.
     */
    onDurable?: (segments: DurableSegment[]) => void;
    /**
     * Segments a continued encode reuses from the run it continues, counted as
     * already encrypted and uploaded, so the bars start where that run left off.
     */
    alreadyDone?: number;
    /** Told about every segment as it is processed; a video one with its start time. */
    onSegment?: (segment: DurableSegment) => void;
    /**
     * Continue a failed encode: the video streams named here restart at
     * segment `startIndex`, and their earlier segments, already in storage,
     * are put back in front of them in the playlist.
     */
    resume?: PipelineResume;
}

/** What a continued encode reuses from the run it continues. */
export interface PipelineResume {
    startIndex: number;
    /** Per resumed video stream: when segment `startIndex` starts, in track ticks. */
    startTfdt: Record<string, number>;
    /** Per resumed video stream: segments 0..startIndex-1, with the next one's start. */
    reused: Record<
        string,
        (DurableSegment & { tfdt: number; nextTfdt: number })[]
    >;
    /** Per resumed video stream: the init its reused segments were muxed against. */
    previousInits: Record<string, Buffer>;
}

/** A file of segments that never reached storage, as `salvage()` hands it on. */
export interface SalvagedUpload {
    filePath: string;
    /** Where it was going. */
    objectKey: string;
    /** What it must measure: the end of its last segment. */
    size: number;
    segments: DurableSegment[];
}

/** A segment that has reached storage, as a continued encode needs to know it. */
export interface DurableSegment {
    /** Its stream directory, e.g. `stream_720p_1280x720`. */
    stream: string;
    /** The file ffmpeg wrote, e.g. `segment_00012.m4s`. */
    file: string;
    /** Its number, from the file name. */
    index: number;
    /**
     * When it starts, in its track's timescale. Video only: a continued encode
     * restarts the video on a segment boundary and re-encodes the audio whole.
     */
    tfdt?: number;
    /** Where its bytes are, relative to the output: `media/<chunk>` or `<stream>/<file>`. */
    mediaFile: string;
    offset?: number;
    length: number;
}

interface ByteRangeEntry {
    /** The original segment filename this entry replaces in the playlist. */
    segmentFile: string;
    length: number;
    offset: number;
    mediaFile: string;
}

const SEGMENT_INDEX_RE = /^segment_(\d+)\./;

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
    /** What the open chunk holds, reported durable once it has uploaded. */
    currentChunkSegments: DurableSegment[];
}

interface StreamState {
    processedSegments: Set<string>;
    /**
     * This stream's own view of the chain, keyed by original segment
     * filename — matching into the playlist is exact, never positional.
     */
    byteRangeEntries: ByteRangeEntry[];
    chain: ChainState;
    /** Ticks added to each new segment of a resumed stream, set by its first segment. */
    tfdtShift?: number;
}

interface UploadTask {
    filePath: string;
    objectKey: string;
    deleteAfterUpload: boolean;
    /** Number of segments this upload represents (for byte-range chunks) */
    segmentCount?: number;
    /** Segments this upload makes durable. */
    durable?: DurableSegment[];
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
    /** Open chunks an abort closed, finishing their writes. */
    private readonly closing: Promise<void>[] = [];
    /** What an abort stopped from starting, for `salvage()` to hand on. */
    private readonly abandoned: UploadTask[] = [];
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
        this.totalSegmentsProduced = config.alreadyDone ?? 0;
        this.segmentsEncrypted = config.alreadyDone ?? 0;
        this.segmentsUploaded = config.alreadyDone ?? 0;
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
        // What a continue reuses shows at once, not when the next segment lands.
        if (this.config.alreadyDone) this.emitProgress();
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
            for (const [streamDir, state] of this.streamStates) {
                await this.rewritePlaylistWithByteRanges(streamDir, state);
            }
        }

        // A continued encode's playlists only hold what this run wrote.
        if (this.config.resume) {
            for (const streamDir of this.streamStates.keys()) {
                await this.stitchResumedPlaylist(
                    streamDir.split(/[\\/]/).pop()!,
                    streamDir
                );
            }
        }

        this.running = false;
        return [...this.uploadedKeys];
    }

    abort(): void {
        this.aborted = true;
        this.running = false;
        // Nothing new starts; what is already sending is left to finish, and
        // `settle()` waits for it. What never started is kept for `salvage()`.
        this.abandoned.push(...this.uploadQueue.splice(0));
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
        }
        // Close any open chunk streams. `salvage()` waits for them to finish.
        for (const chain of this.chains.values()) {
            if (chain.currentChunkStream) {
                const stream = chain.currentChunkStream;
                this.closing.push(
                    new Promise<void>((resolve) => {
                        if (stream.writableFinished) return resolve();
                        stream.once('finish', resolve);
                        stream.once('error', () => resolve());
                    })
                );
                stream.end();
                chain.currentChunkStream = null;
                if (chain.currentChunkSegments.length > 0) {
                    this.abandoned.push({
                        filePath: join(this.chunkDir, chain.currentChunkFile),
                        objectKey: this.chainObjectKey(chain.currentChunkFile),
                        deleteAfterUpload: true,
                        segmentCount: chain.currentChunkSegmentCount,
                        durable: chain.currentChunkSegments,
                    });
                }
            }
        }
    }

    /**
     * Upload files an earlier run of the encode salvaged, as any chunk is
     * uploaded (three attempts), each reported through `onDurable` once it is
     * in storage. One that still fails is left where it is.
     */
    async uploadSalvaged(
        files: SalvagedUpload[],
        onFile?: (done: number, total: number) => void
    ): Promise<void> {
        let done = 0;
        for (const file of files) {
            try {
                await this.executeUpload({
                    filePath: file.filePath,
                    objectKey: file.objectKey,
                    deleteAfterUpload: true,
                    durable: file.segments,
                });
            } catch (err) {
                this.logger.warn(
                    `[pipeline] could not upload kept ${file.objectKey}: ${(err as Error).message}`
                );
            }
            onFile?.(++done, files.length);
        }
    }

    /**
     * After an abort: the files that hold segments but never reached storage,
     * the chunks closed and waiting, and those still open, now closed, each
     * with the segments in it and the size it must have. A continue can upload
     * them instead of making their segments again.
     */
    async salvage(): Promise<SalvagedUpload[]> {
        await Promise.all(this.closing.splice(0));
        const out: SalvagedUpload[] = [];
        for (const task of this.abandoned.splice(0)) {
            const segments = task.durable ?? [];
            if (segments.length === 0) continue;
            try {
                const size = (await stat(task.filePath)).size;
                const expected = Math.max(
                    ...segments.map((s) => (s.offset ?? 0) + s.length)
                );
                // Bytes the records do not describe, or fewer than they do,
                // mean the file is not what it claims to be.
                if (size !== expected) continue;
                out.push({
                    filePath: task.filePath,
                    objectKey: task.objectKey,
                    size,
                    segments,
                });
            } catch {
                // Gone already; nothing to hand on.
            }
        }
        return out;
    }

    /**
     * Wait, for up to `timeoutMs`, for the uploads already sending when the
     * pipeline was aborted. They are let finish rather than cut off: a chunk
     * that does arrive is one a continued encode need not make again.
     */
    async settle(timeoutMs = 30_000): Promise<void> {
        const until = Date.now() + timeoutMs;
        while (this.activeUploads > 0 && Date.now() < until) {
            await new Promise((r) => setTimeout(r, 100));
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

            // A continued audio stream starts a segment early to warm its
            // encoder up; that segment is only the warm-up, and goes.
            const resumed =
                this.config.resume?.startTfdt[streamDirName] !== undefined;
            const index = Number(SEGMENT_INDEX_RE.exec(filename)?.[1] ?? NaN);
            if (resumed && index < this.config.resume!.startIndex) {
                this.totalSegmentsProduced--;
                await unlink(segPath).catch(() => {});
                continue;
            }

            // A continued stream's segments are moved onto the timeline of the
            // run it continues, so the two halves play as one.
            if (resumed) {
                try {
                    await this.alignToResume(
                        state,
                        streamDirName,
                        filename,
                        segPath
                    );
                } catch (err) {
                    this.pipelineError = new Error(
                        `Could not continue ${streamDirName} at ${filename}: ${(err as Error).message}`
                    );
                    return;
                }
            }

            // Read before encryption makes the box structure unreadable.
            const durable = await this.describeSegment(
                streamDirName,
                filename,
                segPath
            );

            try {
                this.config.onSegment?.(durable);
            } catch (err) {
                this.logger.warn(
                    `[pipeline] could not record ${streamDirName}/${filename}: ${(err as Error).message}`
                );
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
                    state,
                    filename,
                    segPath,
                    durable
                );
            } else {
                // Upload individual segment
                const objectKey = this.objectKey(streamDirName, filename);
                this.enqueueUpload({
                    filePath: segPath,
                    objectKey,
                    deleteAfterUpload: true,
                    durable: [
                        { ...durable, length: (await stat(segPath)).size },
                    ],
                });
            }

            this.emitProgress();
        }
    }

    /**
     * Shift a continued stream's segment onto the earlier run's timeline. The
     * first one fixes the shift: it is segment `startIndex`, and must start
     * where that segment did.
     */
    private async alignToResume(
        state: StreamState,
        stream: string,
        file: string,
        segPath: string
    ): Promise<void> {
        const resume = this.config.resume!;
        const buffer = await readFile(segPath);
        if (state.tfdtShift === undefined) {
            const index = Number(SEGMENT_INDEX_RE.exec(file)?.[1] ?? NaN);
            if (index !== resume.startIndex) {
                throw new Error(
                    `expected segment ${resume.startIndex} first, got ${file}`
                );
            }
            state.tfdtShift =
                resume.startTfdt[stream] - readBaseMediaDecodeTime(buffer);
        }
        if (state.tfdtShift !== 0) {
            shiftBaseMediaDecodeTime(buffer, state.tfdtShift);
            await writeFile(segPath, buffer);
        }
    }

    /**
     * Put a continued stream's reused segments back in front of the new ones.
     * One init serves both halves when their sample descriptions agree; when
     * they do not, the reused half keeps its own (`init_r0.mp4`) behind an
     * `#EXT-X-DISCONTINUITY`. Every other stream only has its media sequence
     * set back to 0, which `-start_number` moved.
     */
    private async stitchResumedPlaylist(
        streamDirName: string,
        streamDir: string
    ): Promise<void> {
        const resume = this.config.resume!;
        const playlistPath = join(streamDir, 'playlist.m3u8');
        let content: string;
        try {
            content = await readFile(playlistPath, 'utf-8');
        } catch {
            return;
        }
        const playlist = parseMediaPlaylist(content);
        const reused = resume.reused[streamDirName];
        if (!reused) {
            playlist.mediaSequence = 0;
            await writeFile(
                playlistPath,
                buildMediaPlaylist(playlist),
                'utf-8'
            );
            return;
        }

        const previousInit = resume.previousInits[streamDirName];
        const newInitUri = playlist.maps[0]?.uri;
        if (!previousInit || !newInitUri) {
            throw new Error(
                `${streamDirName}: no init to play the reused segments with`
            );
        }
        const newInit = await readFile(join(streamDir, newInitUri));
        const sameInit = sampleDescription(previousInit).equals(
            sampleDescription(newInit)
        );
        if (!sameInit) {
            await writeFile(join(streamDir, 'init_r0.mp4'), previousInit);
        }
        const timescale = readTrackTimescale(previousInit);

        type Entry = {
            uri: string;
            duration: number;
            byteRange?: HlsByteRange;
        };
        const before: Entry[] = reused.map((r) => ({
            uri: this.config.byteRange ? `../${r.mediaFile}` : r.file,
            duration: (r.nextTfdt - r.tfdt) / timescale,
            ...(r.offset !== undefined
                ? { byteRange: { offset: r.offset, length: r.length } }
                : {}),
        }));
        // The warm-up segment a continued audio stream began with is not played.
        const kept = playlist.segments.filter((s) => {
            const index = Number(SEGMENT_INDEX_RE.exec(s.uri)?.[1] ?? NaN);
            return !(index < resume.startIndex);
        });
        const after: Entry[] = kept.map((s) => ({
            uri: s.uri,
            duration: s.duration,
            ...(s.byteRange ? { byteRange: s.byteRange } : {}),
        }));
        const parts = sameInit
            ? [{ mapUri: newInitUri, segments: [...before, ...after] }]
            : [
                  { mapUri: 'init_r0.mp4', segments: before },
                  { mapUri: newInitUri, segments: after },
              ];
        const joined = assembleSplicedMediaPlaylist(
            parts.map((p) => ({
                mapUri: p.mapUri,
                segments: p.segments.map(({ uri, duration }) => ({
                    uri,
                    duration,
                })),
            })),
            {
                version: playlist.version ?? 7,
                independentSegments: playlist.independentSegments !== false,
            }
        );
        const entries = parts.flatMap((p) => p.segments);
        joined.segments.forEach((segment, i) => {
            if (entries[i].byteRange) segment.byteRange = entries[i].byteRange;
        });
        await writeFile(playlistPath, buildMediaPlaylist(joined), 'utf-8');
    }

    /**
     * A segment's identity and its start time. A start time that
     * cannot be read is left out rather than failing the encode: it only means
     * a continued encode cannot restart at this segment.
     */
    private async describeSegment(
        stream: string,
        file: string,
        segPath: string
    ): Promise<DurableSegment> {
        const index = Number(SEGMENT_INDEX_RE.exec(file)?.[1] ?? NaN);
        let tfdt: number | undefined;
        try {
            tfdt = readBaseMediaDecodeTime(await readFile(segPath));
        } catch (err) {
            this.logger.debug(
                `[pipeline] ${stream}/${file}: no start time (${(err as Error).message})`
            );
        }
        return {
            stream,
            file,
            index,
            ...(tfdt !== undefined ? { tfdt } : {}),
            mediaFile: posix.join(stream, file),
            length: 0,
        };
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
            currentChunkSegments: [],
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
        segmentFile: string,
        segPath: string,
        durable: DurableSegment
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
                `[pipeline] chain ${chain.id}: segment ${segmentFile} is ${segSize} bytes, ` +
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
            const attempt = this.config.attempt ?? 0;
            chain.currentChunkFile =
                attempt > 0
                    ? `${chain.id}_r${attempt}_${chain.currentChunkIndex}.m4s`
                    : `${chain.id}_${chain.currentChunkIndex}.m4s`;
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
            segmentFile,
            length: segSize,
            offset: chain.currentChunkOffset,
            mediaFile: chain.currentChunkFile,
        });
        chain.currentChunkSegments.push({
            ...durable,
            mediaFile: posix.join('media', chain.currentChunkFile),
            offset: chain.currentChunkOffset,
            length: segSize,
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
            durable: chain.currentChunkSegments,
        });

        chain.currentChunkIndex++;
        chain.currentChunkOffset = 0;
        chain.currentChunkSegmentCount = 0;
        chain.currentChunkSegments = [];
    }

    /**
     * Substitute each packed segment's playlist entry with its chunk-chain
     * location: the URI becomes `../media/<chunk>` (the playlist stays in its
     * own stream directory; the chunk it points into is shared, so it lives
     * one level up) and an `#EXT-X-BYTERANGE` carries the ciphertext offsets.
     *
     * A model-level pass, not a line rewrite: everything the encoder did not
     * pack — `#EXT-X-MAP` entries (one, or several in spliced smart-cut
     * output), `#EXT-X-DISCONTINUITY`, any tag it does not know — survives in
     * place. Matching is exact by original segment filename; nothing here
     * depends on disk-discovery order agreeing with playlist order.
     */
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

        const playlist = parseMediaPlaylist(content);
        const entriesByFile = new Map(
            state.byteRangeEntries.map((e) => [e.segmentFile, e])
        );

        let matched = 0;
        for (const segment of playlist.segments) {
            const entry = entriesByFile.get(segment.uri);
            if (!entry) continue;
            segment.uri = `../media/${entry.mediaFile}`;
            segment.byteRange = { length: entry.length, offset: entry.offset };
            matched++;
        }

        if (matched !== state.byteRangeEntries.length) {
            // Packed segments the playlist never mentions mean the played
            // output and the packed bytes have diverged — say so rather than
            // shipping a playlist that silently omits content.
            this.logger.warn(
                `[pipeline] ${streamDir}: ${state.byteRangeEntries.length} packed segment(s) ` +
                    `but only ${matched} matched the playlist`
            );
        }

        await writeFile(playlistPath, buildMediaPlaylist(playlist), 'utf-8');
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
                if (task.durable?.length) {
                    try {
                        this.config.onDurable?.(task.durable);
                    } catch (err) {
                        // A record not kept costs a continue some work, never the encode.
                        this.logger.warn(
                            `[pipeline] could not record durable segments: ${(err as Error).message}`
                        );
                    }
                }

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
            onFileProgress?: (
                uploadedCount: number,
                totalCount: number
            ) => void;
        }
    ): Promise<string[]> {
        const files = await this.walkDir(outputDir);

        const tasks: UploadTask[] = [];
        for (const filePath of files) {
            const relativePath = relative(outputDir, filePath)
                .split(/[\\/]/)
                .join('/');

            // Internal build artifacts, matched by name on the normalised path
            // so Windows separators match too. The packer removes its own list
            // in a finally, so `pack-list.txt` is belt-and-braces — a crashed
            // pack must not put its scratch file in the delivered output.
            const name = posix.basename(relativePath);
            if (name === 'concat.txt' || name === 'pack-list.txt') continue;

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
                {
                    length: Math.max(
                        1,
                        Math.min(this.uploadConcurrency, total)
                    ),
                },
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
