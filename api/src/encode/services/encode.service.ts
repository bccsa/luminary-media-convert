import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join, posix } from 'path';
import { SessionService, type Session } from './session.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { EncryptionService } from './encryption.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import { S3Service } from './s3.service.js';
import { WebhookService } from './webhook.service.js';
import { SegmentPipelineService, type PipelineProgress } from './segment-pipeline.service.js';
import { PreviewService } from './preview.service.js';
import type { WebhookPayloadDto } from '../dto/webhook-payload.dto.js';

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
        private readonly s3Service: S3Service,
        private readonly webhookService: WebhookService,
        private readonly segmentPipelineService: SegmentPipelineService,
        private readonly previewService: PreviewService,
    ) {}

    async processSession(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session) {
            this.logger.error(
                `Session ${sessionId} not found, skipping`,
            );
            return;
        }

        if (!session.encodeConfig) {
            this.logger.error(
                `Session ${sessionId} has no encode config, skipping`,
            );
            this.sessionService.setFailed(sessionId, 'No encoding configuration provided');
            return;
        }

        const outputDir = join(this.workDir, sessionId, 'output');

        try {
            this.sessionService.updateStatus(sessionId, 'encoding');
            this.sessionService.setOutputDir(sessionId, outputDir);
            await this.sendWebhook(session, {
                sessionId,
                status: 'encoding',
                progress: 0,
                message: 'Encoding started',
            });

            const encryptionEnabled =
                session.config.encryption?.enabled !== false &&
                !!session.config.encryption?.keyUrl;

            // Pre-compute encryption materials
            let encryptionKey: Buffer | undefined;
            let encryptionIV: Buffer | undefined;
            let encryptionSalt: Buffer | undefined;

            if (encryptionEnabled) {
                encryptionSalt = this.encryptionService.generateSalt();
                encryptionKey = this.encryptionService.deriveKey(sessionId, encryptionSalt);
                encryptionIV = this.encryptionService.generateIV();
            }

            // Set up S3 path prefix
            const s3PathPrefix = session.config.s3.pathPrefix
                ? session.config.s3.pathPrefix.replace(/\/+$/, '')
                : '';

            // Current pipeline progress state (updated by both FFmpeg and pipeline callbacks)
            // Initialize all bars so the UI shows them from the start
            const currentProgress: PipelineProgress = {
                encoding: 0,
                ...(encryptionEnabled ? { encrypting: 0 } : {}),
                uploading: 0,
            };

            // Create and start the streaming segment pipeline
            const pipeline = this.segmentPipelineService.createPipeline({
                outputDir,
                s3Config: session.config.s3,
                s3PathPrefix,
                encryptionKey,
                encryptionIV,
                byteRange: session.config.byteRange !== false,
                byteRangeMaxFileSizeBytes:
                    (session.config.byteRangeMaxFileSizeMB ?? 500) * 1024 * 1024,
                onProgress: (pipelineUpdate) => {
                    if (pipelineUpdate.encrypting != null) currentProgress.encrypting = pipelineUpdate.encrypting;
                    if (pipelineUpdate.uploading != null) currentProgress.uploading = pipelineUpdate.uploading;
                    this.sessionService.updatePipelineProgress(
                        sessionId,
                        { ...currentProgress },
                    );
                },
            });

            pipeline.start();

            // Run FFmpeg — pipeline polls for segments in the background
            const encodeResult = await this.ffmpegService.encode({
                sessionId,
                inputPath: session.filePath!,
                outputDir,
                encodeConfig: session.encodeConfig,
                // Pipeline handles byte-range and encryption inline
                byteRange: false,
                preByteRangeHook: undefined,
                onProgress: (percent) => {
                    currentProgress.encoding = percent;
                    this.sessionService.updatePipelineProgress(
                        sessionId,
                        { ...currentProgress },
                    );
                    if (
                        percent % 5 < 1 ||
                        percent >= 99
                    ) {
                        this.sendWebhook(session, {
                            sessionId,
                            status: 'encoding',
                            progress: percent,
                            message: `Encoding: ${percent}% complete`,
                        }).catch(() => {});
                    }
                },
            });

            // Check if pipeline encountered an error during encoding
            if (pipeline.error) {
                throw pipeline.error;
            }

            // Drain remaining segments + finalize byte-range chunks
            await pipeline.drain();

            // Playlist post-processing (must happen after drain rewrites byte-range playlists)
            if (encryptionEnabled) {
                await this.encryptionService.injectKeyTagsIntoPlaylists(
                    outputDir,
                    session.config.encryption!.keyUrl!,
                    encryptionIV!,
                );
            }

            // Generate thumbnails
            let thumbnailsVttRelPath: string | undefined;
            if (
                session.encodeConfig.type === 'video' &&
                session.config.thumbnails !== false
            ) {
                try {
                    const concatFilePath = join(outputDir, 'concat.txt');
                    const hasConcatFile = existsSync(concatFilePath);
                    const trimmedDuration = session.encodeConfig.trimSegments?.length
                        ? session.encodeConfig.trimSegments.reduce((sum, s) => sum + (s.outSec - s.inSec), 0)
                        : undefined;

                    const thumbResult =
                        await this.thumbnailService.generateThumbnails({
                            inputPath: session.filePath!,
                            outputDir,
                            duration: trimmedDuration
                                ?? session.probeResult?.format?.duration ?? 0,
                            sourceWidth:
                                session.probeResult?.videoTracks?.[0]?.width ??
                                1920,
                            sourceHeight:
                                session.probeResult?.videoTracks?.[0]?.height ??
                                1080,
                            concatFilePath: hasConcatFile ? concatFilePath : undefined,
                        });
                    if (thumbResult) {
                        thumbnailsVttRelPath = thumbResult.vttRelativePath;
                        this.logger.log(
                            `Generated thumbnail sprites for session ${sessionId}`,
                        );
                    }
                } catch (err) {
                    this.logger.warn(
                        `Thumbnail generation failed for session ${sessionId}: ${(err as Error).message}`,
                    );
                }
            }

            // Upload remaining files (playlists, thumbnails, master.m3u8)
            this.sessionService.updateStatus(sessionId, 'uploading_to_s3');
            this.sessionService.updateProgress(sessionId, 0);
            await this.sendWebhook(session, {
                sessionId,
                status: 'uploading_to_s3',
                progress: 0,
                message: 'Uploading playlists and thumbnails to S3',
            });

            await pipeline.uploadRemainingFiles(outputDir);

            // Collect all uploaded keys
            const allKeys = pipeline.keys;

            // Resolve master playlist and angle playlists
            const anglePlaylistsWithKeys = encodeResult.anglePlaylists.map(
                (ap) => {
                    const key =
                        allKeys.find(
                            (k) => k.split('/').pop() === ap.filename,
                        ) ?? '';
                    return { name: ap.name, key };
                },
            );

            const masterPlaylistKey = allKeys.find(
                (k) => k.split('/').pop() === encodeResult.masterPlaylist,
            ) ?? '';

            const effectiveMasterPlaylist =
                anglePlaylistsWithKeys.length > 0
                    ? anglePlaylistsWithKeys[0].key
                    : masterPlaylistKey;

            const thumbnailsVttKey = thumbnailsVttRelPath
                ? allKeys.find((k) =>
                      k.endsWith(thumbnailsVttRelPath!),
                  )
                : undefined;

            this.sessionService.setCompleted(
                sessionId,
                allKeys,
                effectiveMasterPlaylist,
                anglePlaylistsWithKeys.length > 0 ? anglePlaylistsWithKeys : undefined,
                thumbnailsVttKey,
                encodeResult.segmentFormat,
            );
            await this.sendWebhook(session, {
                sessionId,
                status: 'completed',
                progress: 100,
                message: 'Encoding and upload complete',
                files: allKeys,
                masterPlaylist: effectiveMasterPlaylist,
                anglePlaylists:
                    anglePlaylistsWithKeys.length > 0
                        ? anglePlaylistsWithKeys
                        : undefined,
                thumbnailsVtt: thumbnailsVttKey,
                encryptionKeyHex: encryptionKey
                    ? encryptionKey.toString('hex')
                    : undefined,
            });

            this.logger.log(`Session ${sessionId} completed successfully`);
        } catch (err) {
            const errorMsg = (err as Error).message || 'Unknown error';
            this.logger.error(
                `Session ${sessionId} failed: ${errorMsg}`,
            );
            this.sessionService.setFailed(sessionId, errorMsg);
            await this.sendWebhook(session, {
                sessionId,
                status: 'failed',
                error: errorMsg,
                message: 'Encoding failed',
            });
        } finally {
            await this.previewService.destroy(sessionId);
            await this.cleanupSessionFiles(sessionId, session);
        }
    }

    private async sendWebhook(
        session: Session,
        payload: WebhookPayloadDto,
    ): Promise<void> {
        if (!session.config.webhook) return;
        try {
            await this.webhookService.send(
                session.config.webhook.url,
                session.config.webhook.sessionToken,
                payload,
            );
        } catch {
            // Webhook errors are already logged inside WebhookService
        }
    }

    private async cleanupSessionFiles(
        sessionId: string,
        session: Session,
    ): Promise<void> {
        try {
            const sessionDir = join(this.workDir, sessionId);
            await rm(sessionDir, { recursive: true, force: true });
            this.logger.debug(
                `Cleaned up work directory for session ${sessionId}`,
            );
        } catch (err) {
            this.logger.warn(
                `Failed to clean up session ${sessionId}: ${(err as Error).message}`,
            );
        }
    }
}
