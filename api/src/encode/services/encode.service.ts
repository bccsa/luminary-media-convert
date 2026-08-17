import { Injectable, Logger } from '@nestjs/common';
import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/hls';
import { existsSync } from 'fs';
import { readdir, rm, writeFile } from 'fs/promises';
import { join, posix } from 'path';
import { estimateOutputBytes, formatBytes } from './output-estimate.js';
import { freeBytes } from './disk-space.js';
import {
    SESSION_STATE_FILENAME,
    SessionService,
    type Session,
} from './session.service.js';
import { FfmpegService } from './ffmpeg.service.js';
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
} from './segment-pipeline.service.js';

@Injectable()
export class EncodeService {
    private readonly logger = new Logger(EncodeService.name);
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');

    constructor(
        private readonly sessionService: SessionService,
        private readonly ffmpegService: FfmpegService,
        private readonly encryptionService: EncryptionService,
        private readonly thumbnailService: ThumbnailService,
        private readonly waveformService: WaveformService,
        private readonly s3Service: S3Service,
        private readonly segmentPipelineService: SegmentPipelineService
    ) {}

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

        try {
            const encryptionEnabled =
                session.config.encryption != null &&
                session.config.encryption.enabled !== false;

            // Pre-compute encryption materials. This happens before the status
            // flips to 'encoding' so anything watching that transition can be
            // handed the key it will need to play the output back.
            let encryptionKey: Buffer | undefined;
            let encryptionIV: Buffer | undefined;

            if (encryptionEnabled) {
                encryptionKey = this.encryptionService.generateKey();
                encryptionIV = this.encryptionService.generateIV();
                // On the session before the status flips, so the 'encoding'
                // event and every status read after it carry the key. A CMS
                // that only learned it at completion would have a playable URL
                // in hand, and nothing able to decrypt it, for the length of
                // the encode.
                this.sessionService.setEncryptionKey(
                    sessionId,
                    encryptionKey.toString('hex')
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

            // The playback URL is fully determined once the prefix is — the
            // encode writes exactly one master playlist, at a known name — so
            // it is published now rather than on completion. The caller can
            // save it against its own record while the encode runs, instead of
            // holding a half-finished record open for however long that takes.
            if (session.publicBaseUrl) {
                const masterKey = posix.join(s3PathPrefix, 'master.m3u8');
                const base = session.publicBaseUrl.replace(/\/+$/, '');
                this.sessionService.setHlsUrl(
                    sessionId,
                    `${base}/${masterKey}`
                );
            }

            // Current pipeline progress state (updated by both FFmpeg and pipeline callbacks)
            // Initialize all bars so the UI shows them from the start
            const currentProgress: PipelineProgress = {
                encoding: 0,
                ...(encryptionEnabled ? { encrypting: 0 } : {}),
                uploading: 0,
            };

            // Estimate total segments for progress calculation:
            // numStreams * ceil(duration / segmentDuration)
            const segDur = session.encodeConfig.segmentDuration ?? 6;
            const duration = session.probeResult?.format?.duration ?? 0;
            const numStreams =
                (session.encodeConfig.videoRenditions?.length ?? 0) +
                (session.encodeConfig.audioGroups?.length ?? 0);
            const estimatedTotalSegments =
                numStreams > 0 && duration > 0
                    ? numStreams * Math.ceil(duration / segDur)
                    : undefined;

            // Create and start the streaming segment pipeline
            const pipeline = this.segmentPipelineService.createPipeline({
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
                // Which stream directories share a chunk chain, decided from the
                // config that names them rather than from the names themselves.
                streamChains: this.ffmpegService.buildStreamChainMap(
                    session.encodeConfig
                ),
                audioByteRangeMaxFileSizeBytes:
                    (session.config.audioByteRangeMaxFileSizeMB ?? 50) *
                    1024 *
                    1024,
                segmentDurationSeconds: segDur,
                estimatedTotalSegments,
                onProgress: (pipelineUpdate) => {
                    if (pipelineUpdate.encrypting != null)
                        currentProgress.encrypting = pipelineUpdate.encrypting;
                    if (pipelineUpdate.uploading != null)
                        currentProgress.uploading = pipelineUpdate.uploading;
                    this.sessionService.updatePipelineProgress(sessionId, {
                        ...currentProgress,
                    });
                },
            });

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

            pipeline.start();

            // Run FFmpeg — pipeline polls for segments in the background
            const encodeResult = await this.ffmpegService.encode({
                sessionId,
                inputPath: session.filePath!,
                outputDir,
                encodeConfig: session.encodeConfig,
                onProgress: (percent) => {
                    currentProgress.encoding = percent;
                    this.sessionService.updatePipelineProgress(sessionId, {
                        ...currentProgress,
                    });
                },
            });

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
                // This used to be the expensive one — a fresh FFmpeg pass over
                // the finished output, measured at 114.7s of a 125s encode. It
                // now lays out frames sampled once at ingest and decodes
                // nothing, so it is reported for completeness rather than
                // because anyone will be left waiting on it.
                reportPhase('thumbnails');
                try {
                    const thumbResult =
                        await this.thumbnailService.packForDelivery({
                            sessionId,
                            inputPath: session.filePath!,
                            outputDir,
                            sourceDuration:
                                session.probeResult?.format?.duration ?? 0,
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
            currentProgress.uploading = 0;
            this.sessionService.updatePipelineProgress(sessionId, {
                ...currentProgress,
            });
            this.sessionService.updateStatus(sessionId, 'uploading_to_s3');

            await pipeline.uploadRemainingFiles(outputDir, {
                onFileProgress: (done, total) => {
                    currentProgress.uploading =
                        total > 0 ? Math.round((done / total) * 100) : 100;
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

            this.logger.log(`Session ${sessionId} completed successfully`);
        } catch (err) {
            const errorMsg = (err as Error).message || 'Unknown error';
            this.logger.error(`Session ${sessionId} failed: ${errorMsg}`);
            this.sessionService.setFailed(sessionId, errorMsg);
        } finally {
            await this.cleanupSessionFiles(sessionId);
        }
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
     * `session.json` is spared. Clearing the whole directory used to take it too,
     * which quietly undid session persistence (#67) for exactly the sessions a
     * user comes back to: a completed session vanished on the next restart and the
     * client was told it had expired.
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
