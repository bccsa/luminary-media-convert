import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { join, relative } from 'path';
import { SessionService, type Session } from './session.service.js';
import { FfmpegService } from './ffmpeg.service.js';
import { EncryptionService } from './encryption.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import { S3Service } from './s3.service.js';
import { WebhookService } from './webhook.service.js';
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

            let encryptionKey: Buffer | undefined;

            const encodeResult = await this.ffmpegService.encode({
                sessionId,
                inputPath: session.filePath!,
                outputDir,
                encodeConfig: session.encodeConfig,
                byteRange: session.config.byteRange,
                byteRangeMaxFileSizeBytes:
                    (session.config.byteRangeMaxFileSizeMB ?? 500) * 1024 * 1024,
                preByteRangeHook: encryptionEnabled
                    ? (outDir) => {
                        const result = this.encryptionService.encryptHlsOutput(
                            outDir,
                            sessionId,
                            session.config.encryption!.keyUrl!,
                        );
                        encryptionKey = result.key;
                    }
                    : undefined,
                onProgress: (percent) => {
                    this.sessionService.updateProgress(
                        sessionId,
                        percent,
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

            let thumbnailsVttRelPath: string | undefined;
            if (
                session.encodeConfig.type === 'video' &&
                session.config.thumbnails !== false
            ) {
                try {
                    const thumbResult =
                        await this.thumbnailService.generateThumbnails({
                            inputPath: session.filePath!,
                            outputDir,
                            duration:
                                session.probeResult?.format?.duration ?? 0,
                            sourceWidth:
                                session.probeResult?.videoTracks?.[0]?.width ??
                                1920,
                            sourceHeight:
                                session.probeResult?.videoTracks?.[0]?.height ??
                                1080,
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

            this.sessionService.updateStatus(
                sessionId,
                'uploading_to_s3',
            );
            this.sessionService.updateProgress(sessionId, 0);
            await this.sendWebhook(session, {
                sessionId,
                status: 'uploading_to_s3',
                progress: 0,
                message: 'Uploading encoded files to S3',
            });

            const uploadResult = await this.s3Service.uploadDirectory(
                session.config.s3,
                outputDir,
                encodeResult.masterPlaylist,
                {
                    onProgress: (percent) => {
                        this.sessionService.updateProgress(
                            sessionId,
                            percent,
                        );
                        if (
                            percent % 5 < 1 ||
                            percent >= 99
                        ) {
                            this.sendWebhook(session, {
                                sessionId,
                                status: 'uploading_to_s3',
                                progress: percent,
                                message: `Uploading to S3: ${percent}%`,
                            }).catch(() => {});
                        }
                    },
                },
            );

            const anglePlaylistsWithKeys = encodeResult.anglePlaylists.map(
                (ap) => {
                    const key =
                        uploadResult.keys.find(
                            (k) => k.split('/').pop() === ap.filename,
                        ) ?? uploadResult.masterPlaylistKey;
                    return { name: ap.name, key };
                },
            );

            const effectiveMasterPlaylist =
                anglePlaylistsWithKeys.length > 0
                    ? anglePlaylistsWithKeys[0].key
                    : uploadResult.masterPlaylistKey;

            const thumbnailsVttKey = thumbnailsVttRelPath
                ? uploadResult.keys.find((k) =>
                      k.endsWith(thumbnailsVttRelPath!),
                  )
                : undefined;

            if (encryptionEnabled && encryptionKey) {
                const previewPlaylists = this.collectPlaylists(outputDir);
                const sess = this.sessionService.get(sessionId);
                if (sess) {
                    sess.encryptionKey = encryptionKey;
                    sess.previewPlaylists = previewPlaylists;
                }
                this.logger.debug(
                    `Stored ${Object.keys(previewPlaylists).length} preview playlist(s) for session ${sessionId}`,
                );
            }

            this.sessionService.setCompleted(
                sessionId,
                uploadResult.keys,
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
                files: uploadResult.keys,
                masterPlaylist: effectiveMasterPlaylist,
                anglePlaylists:
                    anglePlaylistsWithKeys.length > 0
                        ? anglePlaylistsWithKeys
                        : undefined,
                thumbnailsVtt: thumbnailsVttKey,
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
            this.cleanupSessionFiles(sessionId, session);
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

    private collectPlaylists(dir: string, base?: string): Record<string, string> {
        const result: Record<string, string> = {};
        const root = base ?? dir;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                Object.assign(result, this.collectPlaylists(fullPath, root));
            } else if (entry.name.endsWith('.m3u8')) {
                const relPath = relative(root, fullPath);
                result[relPath] = readFileSync(fullPath, 'utf-8');
            }
        }
        return result;
    }

    private cleanupSessionFiles(
        sessionId: string,
        session: Session,
    ): void {
        try {
            const sessionDir = join(this.workDir, sessionId);
            rmSync(sessionDir, { recursive: true, force: true });
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
