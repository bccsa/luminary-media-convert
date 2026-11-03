import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/hls-core';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
} from 'fs';
import {
    copyFile,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { basename, join, posix } from 'path';
import { estimateOutputBytes, formatBytes } from './output-estimate.js';
import { failureMessage } from './failure-message.js';
import { freeBytes } from './disk-space.js';
import {
    SESSION_STATE_FILENAME,
    SessionService,
    type Session,
} from './session.service.js';
import {
    FfmpegService,
    type EncodeResult,
    type WaveLayout,
} from './ffmpeg.service.js';
import {
    isQuickTrimConfig,
    isQuickTrimRejection,
    planQuickTrim,
    type QuickTrimPlan,
    type QuickTrimRejection,
    type StreamGrid,
} from './quick-trim-plan.js';
import {
    QuickTrimCancelledError,
    QuickTrimRunError,
} from './quick-trim-runner.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import { EncryptionService } from './encryption.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import {
    readCachedWaveform,
    WAVEFORM_SIDECAR_VERSION,
    WaveformService,
} from './waveform.service.js';
import { S3Service } from './s3.service.js';
import {
    SegmentPipelineService,
    type PipelinePhase,
    type PipelineProgress,
    type PipelineResume,
} from './segment-pipeline.service.js';
import {
    ResumeStore,
    fingerprint,
    restartStreams,
    restorePlaylist,
    resumePlan,
    resumeRefusal,
    stableHash,
    type ResumePlan,
    type ResumeRecord,
    type ResumeState,
} from './encode-resume.js';
import { parseMediaPlaylist } from '@luminary-media-converter/hls-core';
import { readTrackTimescale, sampleDescription } from './fmp4-timeline.js';

/** One run of an encode: its attempt, its IV, and whether it continues an earlier one. */
interface PreparedRun {
    store: ResumeStore;
    attempt: number;
    ivHex?: string;
    /** Whether this run's segments are recorded, for a later run to continue from. */
    recording: boolean;
    /** The runs of ffmpeg the encode makes, when it is one that can be continued. */
    layout?: WaveLayout[];
    /** Waves 0..skipWaves-1 are in storage already and are restored, not run. */
    skipWaves?: number;
    records?: ResumeRecord[];
    /** Segments a continue reuses, which the bars count as done from the start. */
    reusedSegments?: number;
    pipelineResume?: PipelineResume;
    ffmpegResume?: { fromSec: number; startNumber: number };
    waveResume?: {
        skip: number;
        resume?: { fromSec: number; startNumber: number };
    };
}

/** How a run continues from what is in storage. */
interface Continuation {
    plan: ResumePlan;
    records: ResumeRecord[];
    inits: Record<string, Buffer>;
    /** Where the wave that restarts does so; absent when it runs from its start. */
    resume?: { fromSec: number; startNumber: number };
    /** How much of the encode is reused, as seconds of output. */
    doneSec: number;
}

const INIT_FILE_RE = /^init.*\.mp4$/;

/**
 * The share of the storage bar the segments fill; the playlists, sprites and
 * sidecars uploaded at the end fill the rest. One bar that only moves forward,
 * rather than two that each start from zero.
 */
const SEGMENT_UPLOAD_SHARE = 95;

/**
 * The same config with every stream re-encoded — what a quick cut falls back to.
 *
 * Only the copy flags move. A copy rendition already carries the source's own
 * width, height and bitrate (the form mirrors them from the track the moment
 * copy is ticked), so flipping the flag yields a ladder that re-encodes to what
 * would have been copied rather than to some default.
 */
function reEncodedConfig(config: EncodeConfigDto): EncodeConfigDto {
    const copy = structuredClone(config);
    for (const rendition of copy.videoRenditions ?? []) {
        rendition.copyStream = false;
    }
    for (const group of copy.audioGroups ?? []) {
        group.copyStream = false;
    }
    return copy;
}

@Injectable()
export class EncodeService implements OnModuleInit {
    private readonly logger = new Logger(EncodeService.name);
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');

    constructor(
        private readonly sessionService: SessionService,
        private readonly ffmpegService: FfmpegService,
        private readonly encryptionService: EncryptionService,
        private readonly thumbnailService: ThumbnailService,
        private readonly waveformService: WaveformService,
        private readonly segmentPipelineService: SegmentPipelineService
    ) {}

    /**
     * Work out, for encodes that were running when the encoder last stopped,
     * whether they can carry on: they failed without this process seeing it,
     * so nothing offered to continue them.
     */
    async onModuleInit(): Promise<void> {
        for (const session of this.sessionService.list()) {
            if (session.status !== 'failed' || session.resumeFromSec) continue;
            if (!session.encodeConfig || !session.filePath) continue;
            const from = await this.resumeFrom(
                new ResumeStore(join(this.workDir, session.id)),
                session
            );
            if (from) this.sessionService.setResumeFrom(session.id, from);
        }
    }

    private encryptionEnabled(session: {
        config: { encryption?: { enabled?: boolean } | null };
    }): boolean {
        return (
            session.config.encryption != null &&
            session.config.encryption.enabled !== false
        );
    }

    /**
     * Settle what a caller needs to save the output against its own record: the
     * playback URL and, for an encrypted session, the key.
     *
     * Both are fully determined before the encode starts — the destination
     * prefix is fixed and the encode writes exactly one master playlist at a
     * known name; the key is random and local — so they are published when the
     * session is queued, not when its turn comes. A session waiting behind a
     * long encode can then be saved straight away. Idempotent: an existing key
     * is kept, which is what lets a retry stay playable from a record that
     * already holds it.
     */
    prepareDelivery(sessionId: string): void {
        const session = this.sessionService.get(sessionId);
        if (!session) return;

        // The key goes on first: the event that announces the URL is the one a
        // caller reacts to by asking for the key.
        if (this.encryptionEnabled(session) && !session.encryptionKeyHex) {
            this.sessionService.setEncryptionKey(
                sessionId,
                this.encryptionService.generateKey().toString('hex')
            );
        }

        if (session.publicBaseUrl && !session.hlsUrl) {
            const masterKey = posix.join(
                S3Service.canonicalPrefix(session.config.s3.pathPrefix),
                'master.m3u8'
            );
            const base = session.publicBaseUrl.replace(/\/+$/, '');
            this.sessionService.setHlsUrl(sessionId, `${base}/${masterKey}`);
        }
    }

    async processSession(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            this.logger.error(`Session ${sessionId} not found, skipping`);
            return;
        }

        if (!session.encodeConfig) {
            this.logger.error(
                `Session ${sessionId} has no encode config, skipping`
            );
            this.sessionService.setFailed(
                sessionId,
                'No encoding configuration provided'
            );
            return;
        }

        const outputDir = join(this.workDir, sessionId, 'output');

        const shortfall = await this.diskShortfall(session);
        if (shortfall) {
            this.logger.error(`Session ${sessionId} refused: ${shortfall}`);
            this.sessionService.setFailed(sessionId, shortfall);
            return;
        }

        // A retry inherits whatever the failed run left here. Segments from the
        // previous attempt would be picked up by the pipeline and packed into
        // playlists alongside the new ones, so start from an empty directory —
        // which also releases the disk the abandoned output was holding.
        //
        // Not fatal if it fails: an unusable work directory surfaces with a
        // better error a moment later, when the encode tries to write to it.
        await rm(outputDir, { recursive: true, force: true }).catch((err) => {
            this.logger.warn(
                `Could not clear previous output for ${sessionId}: ${(err as Error).message}`
            );
        });

        // Declared outside the try so the failure path can stop it. A pipeline
        // polls on an interval, and nothing below is guaranteed to reach the
        // drain that clears it.
        let pipeline:
            | ReturnType<SegmentPipelineService['createPipeline']>
            | undefined;
        let run: PreparedRun | undefined;

        try {
            const encryptionEnabled = this.encryptionEnabled(session);

            // Normally settled when the session was queued, so a CMS already
            // holds this key; a session that skipped the queue gets it here.
            // Either way it is on the session before the status flips, so the
            // 'encoding' event and every status read after it can serve it.
            let encryptionKey: Buffer | undefined;
            let encryptionIV: Buffer | undefined;

            if (encryptionEnabled) {
                this.prepareDelivery(sessionId);
                encryptionKey = Buffer.from(
                    this.sessionService.get(sessionId)!.encryptionKeyHex!,
                    'hex'
                );
            }
            // Before the IV, which a continued run takes from the run it continues.
            run = await this.prepareRun(session, encryptionKey);
            if (encryptionKey) encryptionIV = Buffer.from(run.ivHex!, 'hex');
            const thisRun = run;
            const initsSaved = new Set<string>();
            if (thisRun.skipWaves) {
                await this.restoreSkippedWaves(
                    thisRun,
                    outputDir,
                    session.config.byteRange !== false
                );
            }

            this.sessionService.updateStatus(sessionId, 'encoding');
            this.sessionService.setOutputDir(sessionId, outputDir);

            // Set up S3 path prefix. This is the prefix every uploaded key is
            // built from — segments, playlists and sidecars all route through
            // the segment pipeline — so it has to be canonical here or keys
            // inherit whatever the caller typed, a leading '/' included.
            const s3PathPrefix = S3Service.canonicalPrefix(
                session.config.s3.pathPrefix
            );

            this.prepareDelivery(sessionId);

            // Current pipeline progress state (updated by both FFmpeg and pipeline callbacks)
            // Initialize all bars so the UI shows them from the start
            const currentProgress: PipelineProgress = {
                encoding: 0,
                ...(encryptionEnabled ? { encrypting: 0 } : {}),
                uploading: 0,
            };

            const segDur = session.encodeConfig.segmentDuration ?? 6;
            const duration = session.probeResult?.format?.duration ?? 0;

            /**
             * The streaming segment pipeline, built once the config it has to
             * describe is settled.
             *
             * Deferred rather than created here because a quick trim may fall
             * back to a full re-encode, and the chunk-chain map and the segment
             * estimate both come from the config that actually runs.
             */
            const createPipeline = (
                config: EncodeConfigDto,
                estimatedTotalSegments: number | undefined
            ) =>
                this.segmentPipelineService.createPipeline({
                    outputDir,
                    s3Config: session.config.s3,
                    s3PathPrefix,
                    encryptionKey,
                    encryptionIV,
                    byteRange: session.config.byteRange !== false,
                    byteRangeMaxFileSizeBytes:
                        (session.config.byteRangeMaxFileSizeMB ?? 500) *
                        1024 *
                        1024,
                    // Which stream directories share a chunk chain, decided from
                    // the config that names them rather than from the names
                    // themselves.
                    streamChains:
                        this.ffmpegService.buildStreamChainMap(config),
                    audioByteRangeMaxFileSizeBytes:
                        (session.config.audioByteRangeMaxFileSizeMB ?? 50) *
                        1024 *
                        1024,
                    segmentDurationSeconds: segDur,
                    estimatedTotalSegments,
                    attempt: thisRun.attempt,
                    resume: thisRun.pipelineResume,
                    alreadyDone: thisRun.reusedSegments ?? 0,
                    onSegment: (segment) => {
                        if (!thisRun.recording) return;
                        if (!initsSaved.has(segment.stream)) {
                            initsSaved.add(segment.stream);
                            this.saveInit(thisRun, outputDir, segment.stream);
                        }
                        if (thisRun.recording && segment.tfdt !== undefined) {
                            thisRun.store.append([
                                {
                                    kind: 'seen',
                                    stream: segment.stream,
                                    index: segment.index,
                                    tfdt: segment.tfdt,
                                },
                            ]);
                        }
                    },
                    onDurable: (segments) => {
                        if (!thisRun.recording) return;
                        thisRun.store.append(
                            segments.map((s) => ({
                                kind: 'durable' as const,
                                ...s,
                            }))
                        );
                    },
                    onProgress: (pipelineUpdate) => {
                        if (pipelineUpdate.encrypting != null)
                            currentProgress.encrypting =
                                pipelineUpdate.encrypting;
                        if (pipelineUpdate.uploading != null)
                            currentProgress.uploading = Math.round(
                                (pipelineUpdate.uploading *
                                    SEGMENT_UPLOAD_SHARE) /
                                    100
                            );
                        this.sessionService.updatePipelineProgress(sessionId, {
                            ...currentProgress,
                        });
                    },
                });

            /**
             * Segments a full re-encode of this config is expected to produce:
             * numStreams * ceil(duration / segmentDuration).
             */
            const estimateSegments = (
                config: EncodeConfigDto
            ): number | undefined => {
                const numStreams =
                    (config.videoRenditions?.length ?? 0) +
                    (config.audioGroups?.length ?? 0);
                return numStreams > 0 && duration > 0
                    ? numStreams * Math.ceil(duration / segDur)
                    : undefined;
            };

            /**
             * Name the post-drain step the session is on.
             *
             * These run after the bar has reached 100% and before the status
             * leaves `encoding`, so without this the UI shows a finished
             * pipeline over work that is still going. Carried on the existing
             * `pipelineProgress` rather than as a new status, because they are
             * not states a session can be resumed or cancelled in — they are
             * commentary on the one it is already in.
             */
            /**
             * Each post-drain step is timed as well as named.
             *
             * This item asked for a measurement before anyone optimised, and a
             * measurement nobody can repeat is worth little — the answer
             * depends on the source, the machine and whether the sprite pass
             * had a concat file to work from. Logging it on every encode means
             * the next person asking "why the wait" reads it off their own run
             * instead of guessing from someone else's.
             */
            let phaseStartedAt = 0;
            let phaseInProgress: PipelinePhase | null = null;

            const finishPhase = (): void => {
                if (!phaseInProgress) return;
                const seconds = ((Date.now() - phaseStartedAt) / 1000).toFixed(
                    1
                );
                this.logger.log(
                    `Session ${sessionId}: ${phaseInProgress} took ${seconds}s`
                );
                phaseInProgress = null;
            };

            const reportPhase = (phase: PipelinePhase): void => {
                finishPhase();
                phaseInProgress = phase;
                phaseStartedAt = Date.now();
                currentProgress.phase = phase;
                this.sessionService.updatePipelineProgress(sessionId, {
                    ...currentProgress,
                });
            };

            const onEncodeProgress = (percent: number): void => {
                currentProgress.encoding = percent;
                this.sessionService.updatePipelineProgress(sessionId, {
                    ...currentProgress,
                });
            };

            // A trim whose every stream is in copy mode is a quick cut: whole
            // GOPs are remuxed and only the partial GOP at each cut point is
            // re-encoded. Inferred with the same function the controller gated
            // on, so what was accepted is what runs.
            let encodeConfig: EncodeConfigDto = session.encodeConfig;
            let plan: QuickTrimPlan | null = null;
            let fallbackReason: string | null = null;

            if (isQuickTrimConfig(encodeConfig)) {
                const planned = await this.buildQuickTrimPlan(
                    session,
                    encodeConfig,
                    outputDir
                );
                if (isQuickTrimRejection(planned))
                    fallbackReason = planned.reason;
                else plan = planned;
            }

            let encodeResult: EncodeResult | undefined;

            if (plan) {
                /*
                 * The pipeline is deliberately not running yet.
                 *
                 * A quick trim is a sequence of ffmpeg jobs, and a video copy
                 * part that lands on the wrong keyframe is deleted and run
                 * again — writing the same segment numbers a second time. A
                 * pipeline polling alongside it would already have encrypted,
                 * packed and uploaded the first attempt's bytes, and nothing
                 * downstream would ever learn they were replaced. The runner is
                 * near-remux speed (measured: ~2.4 s for a 40 s edit), so the
                 * whole output is produced first and the pipeline then
                 * discovers it in one pass — same drain, same packing, same
                 * upload as always, just not concurrently.
                 */
                try {
                    encodeResult = await this.ffmpegService.encodeQuickTrim(
                        {
                            sessionId,
                            inputPath: session.filePath!,
                            outputDir,
                            encodeConfig,
                            onProgress: onEncodeProgress,
                        },
                        plan
                    );
                } catch (err) {
                    // A cancel propagates: falling back to a full re-encode is
                    // the last thing someone who just pressed cancel wants.
                    if (err instanceof QuickTrimCancelledError) throw err;
                    if (!(err instanceof QuickTrimRunError)) throw err;
                    fallbackReason = err.message;
                }
            }

            if (!encodeResult && fallbackReason) {
                // Never a failed session: a source whose geometry does not
                // support a smart cut still has a perfectly good re-encode
                // available, and every copy rendition already carries the
                // source-mirrored width/height/bitrate the precise path needs.
                this.logger.warn(
                    `Session ${sessionId}: quick cut not possible (${fallbackReason}) — re-encoding instead`
                );
                encodeConfig = reEncodedConfig(encodeConfig);
                this.sessionService.setFallbackNote(
                    sessionId,
                    `Quick cut was not possible for this source (${fallbackReason}); ` +
                        'the streams were re-encoded instead.'
                );
                // The runner may have left parts of an output behind, and the
                // precise path has to start from an empty directory for the
                // same reason a retry does — the pipeline would otherwise pack
                // the abandoned attempt's segments in with the new ones.
                //
                // A clear that fails therefore ends the session rather than
                // being logged and stepped over: continuing produces one output
                // spliced from two attempts, uploaded and delivered, with
                // nothing downstream able to tell. Windows makes this reachable
                // rather than theoretical — a file still held by an ffmpeg that
                // has not finished exiting gives EPERM or EBUSY. A failed
                // session can be retried; a corrupt one is not noticed.
                try {
                    await rm(outputDir, { recursive: true, force: true });
                } catch (err) {
                    throw new Error(
                        `Could not clear the partial quick-cut output for session ` +
                            `${sessionId} (${(err as Error).message}), so the re-encode ` +
                            'was not started — its output would have been mixed with the ' +
                            'abandoned attempt. Retry the encode.'
                    );
                }
                currentProgress.encoding = 0;
            }

            pipeline = createPipeline(
                encodeConfig,
                encodeResult && plan
                    ? plan.plannedTotalSegments
                    : estimateSegments(encodeConfig)
            );

            pipeline.start();

            if (!encodeResult) {
                // Run FFmpeg — pipeline polls for segments in the background
                encodeResult = await this.ffmpegService.encode({
                    sessionId,
                    inputPath: session.filePath!,
                    outputDir,
                    encodeConfig,
                    onProgress: onEncodeProgress,
                    ...(thisRun.ffmpegResume
                        ? { resume: thisRun.ffmpegResume }
                        : {}),
                    ...(thisRun.waveResume
                        ? { waveResume: thisRun.waveResume }
                        : {}),
                    ...(thisRun.layout && thisRun.layout.length > 1
                        ? {
                              onWaveDone: (index: number) =>
                                  this.keepWave(thisRun, outputDir, index),
                          }
                        : {}),
                });
            }

            // Check if pipeline encountered an error during encoding
            if (pipeline.error) {
                throw pipeline.error;
            }

            // FFmpeg's own progress reporting stops a hair short often enough
            // that the bar sits at 98% for the whole finalize stretch. FFmpeg
            // has returned, so encoding is provably over — pinned before the
            // first phase is reported, or the drain gets captioned under a bar
            // still claiming to be mid-encode.
            currentProgress.encoding = 100;

            // Drain remaining segments + finalize byte-range chunks.
            //
            // Reported, because this is the first thing that happens after the
            // bar reaches 100% and it is not instant: byte-range consolidation
            // rewrites playlists and can still be uploading. Measuring the
            // post-drain steps without it left the earliest part of the wait
            // unaccounted for.
            reportPhase('draining');
            await pipeline.drain();

            // Playlist post-processing (must happen after drain rewrites byte-range playlists)
            if (encryptionEnabled) {
                reportPhase('finalising-playlists');
                await this.encryptionService.injectKeyTagsIntoPlaylists(
                    outputDir,
                    session.config.encryption?.keyUrl ??
                        LUMINARY_KEY_PLACEHOLDER_URI,
                    encryptionIV!
                );
            }

            // Pack the ingest-time thumbs into delivered sprite sheets.
            //
            // Nothing is decoded from the source here — the frames were sampled
            // once at ingest, and packing lays out whichever of them the output
            // timeline keeps. Which is why `session.config.thumbnails !== false`
            // now gates only the pack and its S3 delivery: the individual thumbs
            // are generated at ingest regardless, because the trim UI's
            // filmstrip needs them whether or not the output ships a storyboard.
            // The flag's meaning — "no thumbnails in the output" — is unchanged.
            let thumbnailsVttRelPath: string | undefined;
            if (
                session.encodeConfig.type === 'video' &&
                session.config.thumbnails !== false
            ) {
                // Lays out frames sampled once at ingest and decodes nothing,
                // so this phase is reported for completeness rather than because
                // anyone will be left waiting on it.
                reportPhase('thumbnails');
                try {
                    const thumbResult =
                        await this.thumbnailService.packForDelivery({
                            sessionId,
                            inputPath: session.filePath!,
                            outputDir,
                            sourceDuration:
                                session.probeResult?.format?.duration ?? 0,
                            alignmentOffset: encodeResult.alignmentOffset,
                            trimSegments: session.encodeConfig.trimSegments,
                            videoTracks: session.probeResult?.videoTracks,
                        });
                    if (thumbResult) {
                        thumbnailsVttRelPath = thumbResult.vttRelativePath;
                        this.logger.log(
                            `Generated thumbnail sprites for session ${sessionId}`
                        );
                    }
                } catch (err) {
                    this.logger.warn(
                        `Thumbnail generation failed for session ${sessionId}: ${(err as Error).message}`
                    );
                }
            }

            // Generate waveform sidecar (waveform.json next to master.m3u8).
            // Works for both video and audio-only encodes; respects trim concat.
            // Non-fatal: a missing waveform just means the client won't render it.
            if ((session.probeResult?.audioTracks?.length ?? 0) > 0) {
                reportPhase('waveform');
                try {
                    const concatFilePath = join(outputDir, 'concat.txt');
                    const hasConcatFile = existsSync(concatFilePath);
                    const outputSidecarPath = join(outputDir, 'waveform.json');
                    // This sidecar describes the delivered media, whose t=0 is
                    // the source's t=alignmentOffset. The session cache
                    // describes the source, for a trim UI that scrubs the
                    // source preview — the two are the same timeline only when
                    // nothing was seeked past, so any offset at all rules the
                    // cache out and the peaks are recomputed against the head
                    // the encode actually kept.
                    //
                    // Read rather than copied: the cache outlives a restart, so
                    // a sidecar from before the peaks were aligned to the
                    // timeline can still be sitting there, and copying the file
                    // whole is exactly the path that would not notice.
                    const alignmentOffset = encodeResult.alignmentOffset;
                    const cached =
                        hasConcatFile || alignmentOffset > 0
                            ? null
                            : await readCachedWaveform(
                                  this.waveformService.cachePath(sessionId)
                              );

                    if (cached) {
                        // Upload-time prime already produced peaks for this
                        // exact source timeline. Reuse instead of running
                        // ffmpeg a second time.
                        await writeFile(
                            outputSidecarPath,
                            JSON.stringify(cached)
                        );
                        this.logger.log(
                            `Reused cached waveform sidecar for session ${sessionId}`
                        );
                    } else {
                        // A trimmed encode's timeline is the stitched concat
                        // clock, so the span the peaks have to cover is the
                        // segments' summed length, not the source's duration —
                        // measured from the in-points buildConcatFile actually
                        // wrote, which are clamped to the alignment offset. A
                        // range starting inside the head contributes only what
                        // survives that clamp, and taking it at face value
                        // would have apad make up the difference in silence the
                        // encode never wrote.
                        const durationSec = hasConcatFile
                            ? (session.encodeConfig.trimSegments ?? []).reduce(
                                  (total, segment) =>
                                      total +
                                      Math.max(
                                          0,
                                          segment.outSec -
                                              Math.max(
                                                  segment.inSec,
                                                  alignmentOffset
                                              )
                                      ),
                                  0
                              )
                            : Math.max(
                                  0,
                                  (session.probeResult?.format?.duration ?? 0) -
                                      alignmentOffset
                              );
                        const peaks =
                            await this.waveformService.generateWaveform({
                                inputPath: session.filePath!,
                                concatFilePath: hasConcatFile
                                    ? concatFilePath
                                    : undefined,
                                durationSec,
                                startOffsetSec: alignmentOffset,
                            });
                        const payload = {
                            version: WAVEFORM_SIDECAR_VERSION,
                            sampleRate: 8000,
                            numPeaks: peaks.length,
                            peaks,
                        };
                        await writeFile(
                            outputSidecarPath,
                            JSON.stringify(payload)
                        );
                        this.logger.log(
                            `Generated waveform sidecar for session ${sessionId} (${peaks.length} peaks)`
                        );
                    }
                } catch (err) {
                    this.logger.warn(
                        `Waveform generation failed for session ${sessionId}: ${(err as Error).message}`
                    );
                }
            }

            // Encrypt the text assets — playlists and VTT sidecars — last.
            //
            // Strictly after everything that reads or rewrites a playlist:
            // the pipeline drain (byte-range packing rewrites media
            // playlists), key-tag injection, and thumbnail VTT generation.
            // Anything moved below this line would be parsing ciphertext.
            //
            // Segments went to S3 as they were produced and are already
            // AES-128 encrypted; the text assets only leave in
            // `uploadRemainingFiles`, immediately below, so this is the last
            // moment they exist in plaintext anywhere.
            //
            // One decision, not two: encrypting the segments and leaving the
            // playlists, chapters and subtitles beside them in the clear
            // protects very little, so this follows `enabled` unless a caller
            // explicitly opts out for a player that cannot decrypt playlists.
            if (
                encryptionEnabled &&
                session.config.encryption?.encryptPlaylists !== false
            ) {
                reportPhase('encrypting-playlists');
                await this.encryptionService.encryptTextAssets(
                    outputDir,
                    encryptionKey!
                );
            }

            // Upload remaining files (playlists, thumbnails, master.m3u8).
            //
            // The upload has a phase of its own — it reports real per-file
            // progress below, and the S3 bar restarts from 0 for it, because
            // what that bar counted until now was segments and this is a
            // different set of files. The caption is what stops the reset
            // reading as work being lost.
            //
            // Set before the status flips, not after: leaving the previous
            // step's phase in place for even one event would caption the
            // upload with whatever ran before it, which is the thing this
            // caption exists to prevent.
            finishPhase();
            currentProgress.phase = 'uploading-playlists';
            currentProgress.uploading = SEGMENT_UPLOAD_SHARE;
            this.sessionService.updatePipelineProgress(sessionId, {
                ...currentProgress,
            });
            this.sessionService.updateStatus(sessionId, 'uploading_to_s3');

            await pipeline.uploadRemainingFiles(outputDir, {
                onFileProgress: (done, total) => {
                    currentProgress.uploading =
                        total > 0
                            ? Math.round(
                                  SEGMENT_UPLOAD_SHARE +
                                      ((100 - SEGMENT_UPLOAD_SHARE) * done) /
                                          total
                              )
                            : 100;
                    this.sessionService.updatePipelineProgress(sessionId, {
                        ...currentProgress,
                    });
                },
            });

            // Collect all uploaded keys
            const allKeys = pipeline.keys;

            // The encode writes a single master playlist — angles included.
            const effectiveMasterPlaylist =
                allKeys.find(
                    (k) => k.split('/').pop() === encodeResult.masterPlaylist
                ) ?? '';

            const thumbnailsVttKey = thumbnailsVttRelPath
                ? allKeys.find((k) => k.endsWith(thumbnailsVttRelPath!))
                : undefined;

            this.sessionService.setCompleted(
                sessionId,
                allKeys,
                effectiveMasterPlaylist,
                thumbnailsVttKey,
                encodeResult.segmentFormat,
                encryptionKey ? encryptionKey.toString('hex') : undefined
            );
            // The client reads the storyboard from S3 from here on, so the one
            // built from the source is no longer looked at. Nothing else prunes
            // the session directory until the session is deleted.
            //
            // Never fatal: the output is already in S3 and the session already
            // marked completed, so failing here would report a successful encode
            // as failed over an unlinked file.
            await this.thumbnailService
                .removePreview(sessionId)
                .catch((err: Error) => {
                    this.logger.warn(
                        `Could not drop source storyboard for ${sessionId}: ${err.message}`
                    );
                });

            // Nothing is left to continue.
            await thisRun.store.clear().catch(() => {});

            this.logger.log(`Session ${sessionId} completed successfully`);
        } catch (err) {
            const errorMsg = (err as Error).message || 'Unknown error';
            // The whole of it in the log; one sentence for whoever started the encode.
            this.logger.error(`Session ${sessionId} failed: ${errorMsg}`);
            this.sessionService.setFailed(sessionId, failureMessage(errorMsg));
        } finally {
            // A drain stops the poll timer on its way out; every other exit from
            // this method — an ffmpeg failure, a refused config, a throw from any
            // step between — leaves it running against a directory the session
            // has finished with.
            //
            // Left running it is not merely a leaked interval. A retry starts a
            // second pipeline over the same output directory, both enqueue each
            // new segment, and whichever uploads second finds the file already
            // deleted by the first — a retry that fails on ENOENT for a segment
            // the encode produced correctly. Aborting an already-drained
            // pipeline is a no-op, so this is unconditional.
            pipeline?.abort();
            // A chunk still sending when the encode failed is one a continue
            // need not make again, so it is given a moment to land.
            if (this.sessionService.get(sessionId)?.status === 'failed') {
                await pipeline?.settle();
                if (run?.recording && pipeline) {
                    await this.keepSalvaged(run, pipeline);
                }
                if (run?.recording) {
                    this.sessionService.setResumeFrom(
                        sessionId,
                        (await this.resumeFrom(run.store, session)) ?? undefined
                    );
                }
            }
            await this.cleanupSessionFiles(sessionId);
        }
    }

    /**
     * Decide how this run starts: continuing the run before it when that one
     * failed partway with the same settings and source, or afresh. Either way
     * it gets an attempt number of its own, which names its chunks apart from
     * any earlier run's.
     */
    private async prepareRun(
        session: Session,
        encryptionKey: Buffer | undefined
    ): Promise<PreparedRun> {
        const store = new ResumeStore(join(this.workDir, session.id));
        const config = session.encodeConfig!;
        const previous = await store.readState();
        const attempt = previous ? previous.attempt + 1 : 0;

        // Cleared until this run fails and works out a new one.
        this.sessionService.setResumeFrom(session.id, undefined);
        let next: Omit<ResumeState, 'attempt' | 'ivHex'> | null = null;
        let layout: WaveLayout[] | undefined;
        const blocker = isQuickTrimConfig(config)
            ? 'a quick cut starts over'
            : this.ffmpegService.resumeBlocker(config);
        if (previous && blocker) {
            this.logger.log(
                `Session ${session.id}: starting over (${blocker})`
            );
        }
        if (session.filePath && !blocker) {
            try {
                const source = await stat(session.filePath);
                layout = this.ffmpegService.waveLayout(config);
                next = {
                    // What decides the output's bytes and where they go.
                    configHash: stableHash({
                        encodeConfig: config,
                        s3: {
                            endPoint: session.config.s3.endPoint,
                            bucket: session.config.s3.bucket,
                            pathPrefix: session.config.s3.pathPrefix,
                        },
                        byteRange: session.config.byteRange,
                        byteRangeMaxFileSizeMB:
                            session.config.byteRangeMaxFileSizeMB,
                        audioByteRangeMaxFileSizeMB:
                            session.config.audioByteRangeMaxFileSizeMB,
                        encryption: session.config.encryption ?? null,
                    }),
                    keyFingerprint: encryptionKey
                        ? fingerprint(encryptionKey.toString('hex'))
                        : undefined,
                    source: { size: source.size, mtimeMs: source.mtimeMs },
                    alignmentOffset:
                        await this.ffmpegService.computeAlignmentOffset(
                            session.filePath,
                            config
                        ),
                    videoStreams: layout.flatMap((w) => w.videoStreams),
                    segmentDuration: config.segmentDuration ?? 6,
                };
            } catch (err) {
                next = null;
                this.logger.warn(
                    `Session ${session.id}: this run cannot be continued later (${(err as Error).message})`
                );
            }
        }

        if (next && layout && previous) {
            const refusal =
                resumeRefusal(previous, next) ??
                (encryptionKey && !previous.ivHex
                    ? 'no IV was recorded'
                    : null);
            // What the failed run kept goes up first; only then is it stored.
            if (!refusal) await this.uploadPending(store, session);
            const c = refusal
                ? null
                : this.continuation(store, layout, session);
            const continued =
                !!c &&
                (await store
                    .continueWith({ ...next, attempt, ivHex: previous.ivHex })
                    .then(
                        () => true,
                        (err: Error) => {
                            this.logger.warn(
                                `Session ${session.id}: could not keep the state to continue (${err.message})`
                            );
                            return false;
                        }
                    ));
            if (c && continued) {
                this.logger.log(
                    `Session ${session.id}: continuing, attempt ${attempt}: ` +
                        (layout.length > 1
                            ? `${c.plan.skip} of ${layout.length} wave(s) already in storage, `
                            : '') +
                        (c.resume
                            ? `restarting at segment ${c.resume.startNumber} (${c.resume.fromSec.toFixed(1)}s)`
                            : 'the next wave from its start')
                );
                return {
                    store,
                    attempt,
                    ivHex: previous.ivHex,
                    recording: true,
                    layout,
                    skipWaves: c.plan.skip,
                    records: c.records,
                    reusedSegments:
                        Object.values(c.plan.point?.reused ?? {}).reduce(
                            (n, segments) => n + segments.length,
                            0
                        ) +
                        c.records
                            .filter(
                                (
                                    r
                                ): r is Extract<
                                    ResumeRecord,
                                    { kind: 'waveDone' }
                                > =>
                                    r.kind === 'waveDone' &&
                                    r.wave < c.plan.skip
                            )
                            .reduce(
                                (n, r) =>
                                    n +
                                    Object.values(r.counts).reduce(
                                        (a, b) => a + b,
                                        0
                                    ),
                                0
                            ),
                    ...(c.plan.point
                        ? {
                              pipelineResume: {
                                  ...c.plan.point,
                                  previousInits: c.inits,
                              },
                          }
                        : {}),
                    ...(layout.length === 1
                        ? c.resume
                            ? { ffmpegResume: c.resume }
                            : {}
                        : {
                              waveResume: {
                                  skip: c.plan.skip,
                                  resume: c.resume,
                              },
                          }),
                };
            }
            this.logger.log(
                `Session ${session.id}: starting over (${
                    refusal ?? 'nothing in storage to continue from'
                })`
            );
        }

        const ivHex = encryptionKey
            ? this.encryptionService.generateIV().toString('hex')
            : undefined;
        // Not being able to keep the state costs a later continue, never this encode.
        let recording = !!next;
        try {
            await store.reset({
                ...(next ?? {
                    configHash: '',
                    source: { size: 0, mtimeMs: 0 },
                    alignmentOffset: 0,
                    videoStreams: [],
                    segmentDuration: 0,
                }),
                attempt,
                ivHex,
            });
        } catch (err) {
            recording = false;
            this.logger.warn(
                `Session ${session.id}: could not keep what a later run would continue from (${(err as Error).message})`
            );
        }
        return {
            store,
            attempt,
            ivHex,
            recording,
            ...(next ? { layout } : {}),
        };
    }

    /**
     * How a run would continue from what `store` holds, or null when it would
     * start over: what it skips and restarts, and everything that has to be
     * there to do so, the init segments and the finished waves' playlists.
     */
    private continuation(
        store: ResumeStore,
        layout: WaveLayout[],
        session: Session,
        countPending = false
    ): Continuation | null {
        const stored = store.readRecords();
        // An offer counts the kept files a continue will upload first; a run
        // only what has actually reached storage.
        const records: ResumeRecord[] = countPending
            ? [
                  ...stored,
                  ...store.pending(stored).flatMap((p) =>
                      p.segments.map((s) => ({
                          kind: 'durable' as const,
                          ...s,
                      }))
                  ),
              ]
            : stored;
        const plan = resumePlan(layout, records);
        if (!plan) return null;
        const skipped = layout.slice(0, plan.skip);
        const resumedVideo = plan.point
            ? restartStreams(layout[plan.skip]!)
            : [];
        const inits = this.readSavedInits(store, [
            ...resumedVideo,
            ...skipped.flatMap((w) => [...w.videoStreams, ...w.audioStreams]),
        ]);
        if (!inits) return null;
        for (const [n, wave] of skipped.entries()) {
            const files = [
                ...(layout.length > 1 ? [wave.masterName] : []),
                ...[...wave.videoStreams, ...wave.audioStreams].map(
                    (s) => `${s}.m3u8`
                ),
            ];
            if (files.some((f) => !existsSync(join(store.waveDir(n), f))))
                return null;
        }
        let resume: Continuation['resume'];
        if (plan.point) {
            const first = resumedVideo[0]!;
            resume = {
                fromSec:
                    (plan.point.startTfdt[first] -
                        plan.point.reused[first][0].tfdt) /
                    readTrackTimescale(inits[first]),
                startNumber: plan.point.startIndex,
            };
        }
        const duration = session.probeResult?.format?.duration ?? 0;
        const waveFraction =
            duration > 0 && resume ? resume.fromSec / duration : 0;
        return {
            plan,
            records,
            inits,
            resume,
            doneSec: ((plan.skip + waveFraction) / layout.length) * duration,
        };
    }

    /** Where a continue would restart, as seconds of output reused, or null when it would start over. */
    private async resumeFrom(
        store: ResumeStore,
        session: Session
    ): Promise<number | null> {
        try {
            const config = session.encodeConfig;
            if (!config || (await store.readState()) === null) return null;
            const c = this.continuation(
                store,
                this.ffmpegService.waveLayout(config),
                session,
                true
            );
            return c && c.doneSec > 0 ? c.doneSec : null;
        } catch {
            return null;
        }
    }

    /**
     * Put the waves a continue skips back into the output: their master and,
     * per stream, its init and the playlist ffmpeg wrote, pointed at where its
     * segments are in storage. They upload with everything else at the end.
     */
    private async restoreSkippedWaves(
        run: PreparedRun,
        outputDir: string,
        byteRange: boolean
    ): Promise<void> {
        const layout = run.layout!;
        for (let n = 0; n < (run.skipWaves ?? 0); n++) {
            const wave = layout[n]!;
            const waveDir = run.store.waveDir(n);
            await mkdir(outputDir, { recursive: true });
            if (layout.length > 1) {
                await copyFile(
                    join(waveDir, wave.masterName),
                    join(outputDir, wave.masterName)
                );
            }
            for (const stream of [...wave.videoStreams, ...wave.audioStreams]) {
                const streamDir = join(outputDir, stream);
                await mkdir(streamDir, { recursive: true });
                const initsDir = run.store.initsDir(stream);
                const init = readdirSync(initsDir)[0]!;
                await copyFile(join(initsDir, init), join(streamDir, init));
                await writeFile(
                    join(streamDir, 'playlist.m3u8'),
                    restorePlaylist(
                        await readFile(join(waveDir, `${stream}.m3u8`), 'utf8'),
                        stream,
                        run.records ?? [],
                        byteRange
                    )
                );
            }
        }
    }

    /**
     * Keep a finished wave's playlists, as ffmpeg wrote them, so a later
     * continue can skip it. Not for the wave a continue restarted: its
     * playlist holds only the segments this run made, and a later continue
     * restarts it from its records instead.
     */
    private async keepWave(
        run: PreparedRun,
        outputDir: string,
        index: number
    ): Promise<void> {
        if (!run.recording || !run.layout) return;
        if (run.waveResume?.resume && index === run.waveResume.skip) return;
        try {
            const wave = run.layout[index]!;
            const waveDir = run.store.waveDir(index);
            await mkdir(waveDir, { recursive: true });
            await copyFile(
                join(outputDir, wave.masterName),
                join(waveDir, wave.masterName)
            );
            const counts: Record<string, number> = {};
            for (const stream of [...wave.videoStreams, ...wave.audioStreams]) {
                const text = await readFile(
                    join(outputDir, stream, 'playlist.m3u8'),
                    'utf8'
                );
                await writeFile(join(waveDir, `${stream}.m3u8`), text);
                counts[stream] = parseMediaPlaylist(text).segments.length;
            }
            run.store.append([{ kind: 'waveDone', wave: index, counts }]);
        } catch (err) {
            this.logger.warn(
                `Could not keep wave ${index}: ${(err as Error).message}`
            );
        }
    }

    /**
     * Keep what a failed run made but never uploaded, beside its records, so a
     * continue can upload it rather than make it again. Only files the
     * pipeline closed in an orderly way and whose size matches their segments
     * are kept; a run killed outright keeps nothing this way.
     */
    private async keepSalvaged(
        run: PreparedRun,
        pipeline: ReturnType<SegmentPipelineService['createPipeline']>
    ): Promise<void> {
        try {
            const salvaged = await pipeline.salvage();
            if (salvaged.length === 0) return;
            await mkdir(run.store.pendingDir, { recursive: true });
            for (const file of salvaged) {
                const name = basename(file.objectKey);
                await rename(file.filePath, join(run.store.pendingDir, name));
                run.store.append([
                    {
                        kind: 'pending',
                        name,
                        objectKey: file.objectKey,
                        size: file.size,
                        segments: file.segments,
                    },
                ]);
            }
            this.logger.log(
                `Kept ${salvaged.length} file(s) of segments that had not reached storage`
            );
        } catch (err) {
            this.logger.warn(
                `Could not keep the segments that had not reached storage: ${(err as Error).message}`
            );
        }
    }

    /** Upload what a failed run kept, recording each file's segments as stored once it is. */
    private async uploadPending(
        store: ResumeStore,
        session: Session
    ): Promise<void> {
        const pending = store.pending(store.readRecords());
        if (pending.length === 0) return;
        const pipeline = this.segmentPipelineService.createPipeline({
            outputDir: store.pendingDir,
            s3Config: session.config.s3,
            s3PathPrefix: S3Service.canonicalPrefix(
                session.config.s3.pathPrefix
            ),
            byteRange: session.config.byteRange !== false,
            byteRangeMaxFileSizeBytes: 0,
            onDurable: (segments) =>
                store.append(
                    segments.map((s) => ({ kind: 'durable' as const, ...s }))
                ),
        });
        await pipeline.uploadSalvaged(
            pending.map((p) => ({
                filePath: join(store.pendingDir, p.name),
                objectKey: p.objectKey,
                size: p.size,
                segments: p.segments,
            }))
        );
    }

    /**
     * Keep a stream's init beside the records, the first time one of its
     * segments is seen: ffmpeg writes the init before the first segment, and
     * the segments in storage cannot play without it. A continued run keeps
     * the one saved; if its own differs, its segments could not be joined to a
     * later run with that init, so recording stops and a later failure starts
     * over.
     */
    private saveInit(
        run: PreparedRun,
        outputDir: string,
        stream: string
    ): void {
        try {
            const streamDir = join(outputDir, stream);
            const name = readdirSync(streamDir).find((f) =>
                INIT_FILE_RE.test(f)
            );
            if (!name) return;
            const dir = run.store.initsDir(stream);
            const saved = existsSync(dir) ? readdirSync(dir)[0] : undefined;
            if (saved) {
                const same = sampleDescription(
                    readFileSync(join(dir, saved))
                ).equals(
                    sampleDescription(readFileSync(join(streamDir, name)))
                );
                if (!same) {
                    run.recording = false;
                    void run.store.clear();
                }
                return;
            }
            mkdirSync(dir, { recursive: true });
            copyFileSync(join(streamDir, name), join(dir, name));
        } catch (err) {
            this.logger.warn(
                `Could not keep the init of ${stream}: ${(err as Error).message}`
            );
        }
    }

    private readSavedInits(
        store: ResumeStore,
        streams: string[]
    ): Record<string, Buffer> | null {
        const inits: Record<string, Buffer> = {};
        for (const stream of streams) {
            const dir = store.initsDir(stream);
            const name = existsSync(dir) ? readdirSync(dir)[0] : undefined;
            if (!name) return null;
            inits[stream] = readFileSync(join(dir, name));
        }
        return inits;
    }

    /**
     * Scan the keyframe grids this config's streams will be cut on, and plan
     * the parts.
     *
     * The grids come from the muxer rather than from the probe's head sample:
     * the planner aims copy parts at exact keyframe times over the whole file,
     * and a cadence that held for the first few seconds is not a promise about
     * the last. One scan per source video track, reused by every rendition of
     * it — the grid is a property of the track, not of the output stream.
     *
     * A scan that fails is a rejection rather than a throw, because the answer
     * to both is the same: re-encode instead.
     */
    private async buildQuickTrimPlan(
        session: Session,
        encodeConfig: EncodeConfigDto,
        outputDir: string
    ): Promise<QuickTrimPlan | QuickTrimRejection> {
        const targets = this.ffmpegService.quickTrimStreamTargets(encodeConfig);
        const grids = new Map<number, number[]>();
        const streams: StreamGrid[] = [];

        try {
            for (const target of targets) {
                if (target.kind !== 'video') {
                    // Audio has no grid: its junctions land on an AAC frame at
                    // mux time, which is finer than anything worth planning.
                    streams.push({
                        streamDir: target.streamDir,
                        kind: 'audio',
                        keyframes: null,
                    });
                    continue;
                }

                let grid = grids.get(target.sourceTrackIndex);
                if (!grid) {
                    grid = await this.ffmpegService.scanKeyframeGrid(
                        session.filePath!,
                        target.sourceTrackIndex,
                        join(outputDir, `kfscan-${target.streamDir}`)
                    );
                    grids.set(target.sourceTrackIndex, grid);
                }
                // Strict on unknowns, like the eligibility gate: a track the
                // probe could not characterise is assumed to reorder, which
                // only costs one bridged GOP on a trim that starts at zero.
                const track =
                    session.probeResult?.videoTracks[target.sourceTrackIndex];
                streams.push({
                    streamDir: target.streamDir,
                    kind: 'video',
                    keyframes: grid,
                    reordersAtStart: (track?.hasBFrames ?? 1) > 0,
                });
            }
        } catch (err) {
            return {
                reason: `keyframe grid could not be scanned: ${(err as Error).message}`,
            };
        }

        return planQuickTrim({
            streams,
            trimSegments: encodeConfig.trimSegments ?? [],
            segmentDuration: encodeConfig.segmentDuration ?? 6,
        });
    }

    /**
     * Reclaim what a finished encode leaves behind, without losing the session.
     *
     * On success the source upload, the preview cache, the waveform sidecar and
     * the encoded output have no remaining reader: the output is in the client's
     * bucket, and a re-encode is a new session with a new upload. They go
     * immediately — the source is the largest thing the encoder ever holds, and
     * staging shares a host with production (#59), so one filling the disk takes
     * the other down with it.
     *
     * `session.json` is spared: clearing it with the rest undoes session
     * persistence (#67) for exactly the sessions a user comes back to — a
     * completed session vanishes on the next restart and the client is told it
     * has expired.
     *
     * A failed session keeps everything until the sweep ages it out (#73). A
     * failure is when someone wants to retry or inspect the input.
     */
    /**
     * Why this encode cannot fit on disk, or null when it can (or cannot be
     * judged).
     *
     * Checked before any work starts. Without it an encode runs out of space at
     * whatever line touches the disk first and reports a raw ENOSPC — after the
     * source has been uploaded, the job queued, and in one case forty minutes of
     * encoding already spent.
     *
     * Silent when the estimate or the free-space reading is unavailable: a
     * missing figure is a reason to proceed as before, not to refuse work.
     */
    private async diskShortfall(session: Session): Promise<string | null> {
        const duration = session.probeResult?.format?.duration ?? 0;
        const needed = estimateOutputBytes(
            session.encodeConfig ?? {},
            duration
        );
        if (needed <= 0) return null;

        const free = await freeBytes(this.workDir);
        if (free === null || free >= needed) return null;

        return (
            `Not enough disk space on the encoder: this encode needs about ` +
            `${formatBytes(needed)} and only ${formatBytes(free)} is free. ` +
            `Free space and retry — the uploaded source is kept.`
        );
    }

    private async cleanupSessionFiles(sessionId: string): Promise<void> {
        const status = this.sessionService.get(sessionId)?.status;

        // A failed encode keeps its source — that is what makes a retry possible
        // without uploading gigabytes again. Its output is regenerable, so there
        // is no reason to hold it: an abandoned attempt left 4.9 GB on a volume
        // that had already run out of space, and the next run discards it anyway.
        if (status === 'failed') {
            await rm(join(this.workDir, sessionId, 'output'), {
                recursive: true,
                force: true,
            }).catch((err) => {
                this.logger.warn(
                    `Failed to clear output for failed session ${sessionId}: ${(err as Error).message}`
                );
            });
            return;
        }

        if (status !== 'completed') return;

        const sessionDir = join(this.workDir, sessionId);
        try {
            const entries = await readdir(sessionDir);
            await Promise.all(
                entries
                    .filter((entry) => entry !== SESSION_STATE_FILENAME)
                    .map((entry) =>
                        rm(join(sessionDir, entry), {
                            recursive: true,
                            force: true,
                        })
                    )
            );
            this.logger.debug(
                `Cleaned up work directory for session ${sessionId}`
            );
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
            this.logger.warn(
                `Failed to clean up session ${sessionId}: ${(err as Error).message}`
            );
        }
    }
}
