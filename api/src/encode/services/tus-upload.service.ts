import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import { TusdServer } from 'node-tusd';
import { join, basename } from 'path';
import { mkdirSync } from 'fs';
import { rename, copyFile, unlink, mkdir, access, stat } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';
import { PreviewService } from './preview.service.js';
import { WebhookService } from './webhook.service.js';
import { WaveformService } from './waveform.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import { hasAllowedExtension } from './media-extensions.js';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
const EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class TusUploadService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TusUploadService.name);
    private tusdServer!: TusdServer;
    private readonly tusDir: string;
    private readonly workDir: string;
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    /**
     * Final uploads whose completion we are watching from the filesystem side.
     *
     * The post-finish hook is delivered over an HTTP request whose context tusd
     * ties to the client's connection. The browser closes that connection the
     * instant it has its 201 — it has no reason to linger — so the hook loses a
     * race it should never have been in, and the session sticks at "uploading"
     * with the file stranded. Observed twice in four uploads. The file itself
     * reaching its declared size is the ground truth, so watch for that and run
     * the same finalisation if the hook never arrives.
     */
    private readonly pendingFinals = new Map<
        string,
        { timer: ReturnType<typeof setInterval>; deadline: number }
    >();

    constructor(
        private readonly sessionService: SessionService,
        private readonly probeService: ProbeService,
        private readonly previewService: PreviewService,
        private readonly webhookService: WebhookService,
        private readonly waveformService: WaveformService,
        private readonly thumbnailService: ThumbnailService,
    ) {
        this.workDir = process.env.WORK_DIR || join(process.cwd(), 'work');
        this.tusDir = join(this.workDir, '.tus-uploads');
        mkdirSync(this.tusDir, { recursive: true });
    }

    async onModuleInit(): Promise<void> {
        const maxSize =
            parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) ||
            DEFAULT_MAX_SIZE;
        // Tusd handles CORS independently. We allow all origins (tusd default)
        // because the tus endpoint is protected by bearer token auth in
        // onIncomingRequest — no ambient credentials are used.
        this.tusdServer = new TusdServer({
            path: '/api/tus',
            directory: this.tusDir,
            maxSize,
            expirationMs: EXPIRATION_MS,
            allowedHeaders: ['Authorization'],

            onIncomingRequest: async (req) => {
                const auth = req.headers['authorization'];
                if (!auth || !auth.startsWith('Bearer ')) {
                    throw {
                        status_code: 401,
                        body: 'Missing or invalid Authorization header',
                    };
                }

                const token = auth.slice('Bearer '.length).trim();
                if (!token) {
                    throw { status_code: 401, body: 'Empty bearer token' };
                }

                const session = this.sessionService.getBySessionToken(token);
                if (!session) {
                    throw {
                        status_code: 401,
                        body: 'Invalid or expired session token',
                    };
                }
            },

            onUploadCreate: async (_req, upload) => {
                const sessionId = upload.metadata?.sessionId;
                if (!sessionId) {
                    return;
                }

                const session = this.sessionService.get(sessionId);
                if (!session) {
                    throw {
                        status_code: 404,
                        body: `Session ${sessionId} not found`,
                    };
                }

                if (
                    session.status !== 'created' &&
                    session.status !== 'uploading'
                ) {
                    throw {
                        status_code: 400,
                        body: `Session is not accepting uploads (current status: ${session.status})`,
                    };
                }

                const filename = upload.metadata?.filename;
                if (filename && !hasAllowedExtension(filename)) {
                    throw {
                        status_code: 415,
                        body: `Unsupported file type. Allowed: media files (video/audio).`,
                    };
                }

                this.sessionService.updateStatus(sessionId, 'uploading');
                this.sendStatusWebhook(sessionId, 'uploading');

                if (upload.isFinal || (!upload.isPartial && upload.size)) {
                    this.watchFinalUpload(
                        upload.id,
                        sessionId,
                        upload.size ?? 0,
                        basename(upload.metadata?.filename || 'input') || 'input',
                    );
                }
            },

            onUploadFinish: async (_req, upload) => {
                // With parallelUploads > 1, tus-js-client propagates metadata
                // (including sessionId) to every partial chunk upload. Skip
                // partial chunks — only act on the final concatenation or on a
                // plain single-file upload (isPartial=false, isFinal=false).
                if (upload.isPartial) {
                    return;
                }

                const sessionId = upload.metadata?.sessionId;
                if (!sessionId) {
                    return;
                }

                const rawFilename = upload.metadata?.filename || 'input';
                const filename = basename(rawFilename) || 'input';
                const tusFilePath = upload.storage?.path;
                if (!tusFilePath) {
                    this.logger.error(
                        `No storage path for completed upload ${upload.id}`,
                    );
                    return;
                }

                const sessionDir = join(this.workDir, sessionId);
                await mkdir(sessionDir, { recursive: true });

                const destPath = join(sessionDir, filename);

                // Idempotency: if file is already at destination (e.g. duplicate
                // post-finish delivery from tusd retry), skip the move.
                const alreadyMoved = await access(destPath).then(() => true).catch(() => false);
                if (!alreadyMoved) {
                    try {
                        await rename(tusFilePath, destPath);
                    } catch (err: unknown) {
                        const code = (err as NodeJS.ErrnoException).code;
                        if (code !== 'EXDEV') {
                            // Not a cross-device error — log and re-throw so the
                            // real cause appears in the tusd hook error log.
                            this.logger.error(
                                `Failed to move upload file (${code}): ${tusFilePath} → ${destPath}`,
                            );
                            throw err;
                        }
                        // Cross-device fallback: copy then delete
                        await copyFile(tusFilePath, destPath);
                        await unlink(tusFilePath);
                    }
                }

                // Clean up tusd metadata sidecar (.info file)
                await unlink(`${tusFilePath}.info`).catch(() => {});

                await this.finalizeUpload(sessionId, destPath);
                this.clearFinalWatch(upload.id);
            },
        });

        await this.tusdServer.start();

        // Schedule periodic cleanup every 30 minutes
        this.cleanupInterval = setInterval(() => {
            this.tusdServer.cleanUpExpiredUploads().then((count) => {
                if (count > 0) {
                    this.logger.log(`Periodic cleanup: removed ${count} expired upload(s)`);
                }
            }).catch((err) => {
                this.logger.warn(`Periodic cleanup failed: ${(err as Error).message}`);
            });
        }, 30 * 60 * 1000);

        this.logger.log(
            `TUS server initialised (maxSize: ${maxSize} bytes, expiration: ${EXPIRATION_MS / 1000}s)`,
        );
    }

    async onModuleDestroy(): Promise<void> {
        for (const id of [...this.pendingFinals.keys()]) this.clearFinalWatch(id);
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        try {
            await this.tusdServer.cleanUpExpiredUploads();
            this.logger.log('Cleaned up expired TUS uploads on shutdown');
        } catch (err) {
            this.logger.warn(
                `Failed to clean up expired uploads: ${(err as Error).message}`,
            );
        }

        try {
            await this.tusdServer.stop();
        } catch (err) {
            this.logger.warn(
                `Failed to stop TUS server: ${(err as Error).message}`,
            );
        }
    }

    handle(req: IncomingMessage, res: ServerResponse): void {
        this.tusdServer.handle(req, res);
    }

    /**
     * Run the post-ingest pipeline once a source file is in place at destPath:
     * record file path, probe metadata, init preview, transition session to
     * 'uploaded', and webhook the status.
     *
     * Shared between tus uploads and URL ingestion so both paths converge on
     * identical post-ingest behaviour.
     */
    private watchFinalUpload(
        uploadId: string,
        sessionId: string,
        expectedSize: number,
        filename: string,
    ): void {
        this.clearFinalWatch(uploadId);
        const deadline = Date.now() + 10 * 60_000;
        const timer = setInterval(() => {
            void this.reconcileFinalUpload(
                uploadId,
                sessionId,
                expectedSize,
                filename,
                deadline,
            );
        }, 2_000);
        timer.unref?.();
        this.pendingFinals.set(uploadId, { timer, deadline });
    }

    private clearFinalWatch(uploadId: string): void {
        const pending = this.pendingFinals.get(uploadId);
        if (pending) {
            clearInterval(pending.timer);
            this.pendingFinals.delete(uploadId);
        }
    }

    /** Runs the hook's work from filesystem evidence when the hook was killed. */
    private async reconcileFinalUpload(
        uploadId: string,
        sessionId: string,
        expectedSize: number,
        filename: string,
        deadline: number,
    ): Promise<void> {
        const session = this.sessionService.get(sessionId);
        // Hook won the race, or the session is gone: nothing left to rescue.
        if (!session || session.filePath) {
            this.clearFinalWatch(uploadId);
            return;
        }
        if (Date.now() > deadline) {
            this.logger.warn(
                `Gave up waiting for final upload ${uploadId} of session ${sessionId}`,
            );
            this.clearFinalWatch(uploadId);
            return;
        }

        const tusFilePath = join(this.tusDir, uploadId);
        let size: number;
        try {
            size = (await stat(tusFilePath)).size;
        } catch {
            return; // Not concatenated yet.
        }
        if (expectedSize > 0 && size !== expectedSize) return;

        this.clearFinalWatch(uploadId);
        this.logger.warn(
            `post-finish hook never arrived for upload ${uploadId}; finalising session ${sessionId} from disk`,
        );
        try {
            const sessionDir = join(this.workDir, sessionId);
            await mkdir(sessionDir, { recursive: true });
            const destPath = join(sessionDir, filename);
            const alreadyMoved = await access(destPath)
                .then(() => true)
                .catch(() => false);
            if (!alreadyMoved) {
                try {
                    await rename(tusFilePath, destPath);
                } catch (err: unknown) {
                    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
                    await copyFile(tusFilePath, destPath);
                    await unlink(tusFilePath);
                }
            }
            await unlink(`${tusFilePath}.info`).catch(() => {});
            await this.finalizeUpload(sessionId, destPath);
        } catch (err) {
            this.logger.error(
                `Reconciling upload ${uploadId} failed: ${(err as Error).message}`,
            );
        }
    }

    async finalizeUpload(sessionId: string, destPath: string): Promise<void> {
        this.sessionService.setFilePath(sessionId, destPath);

        const probeResult = await this.probeService.probe(destPath);

        // Initialize preview before exposing probe result —
        // clients poll for probeResult and immediately use preview
        // endpoints, so the preview must be ready first.
        this.sessionService.setProbeResult(sessionId, probeResult);
        try {
            await this.previewService.init(sessionId);
        } catch (err) {
            this.logger.warn(`Preview init failed for ${sessionId}: ${(err as Error).message}`);
        }

        this.sessionService.updateStatus(sessionId, 'uploaded');
        this.sendStatusWebhook(sessionId, 'uploaded');

        // Prime the waveform cache in the background — by the time the user
        // opens the trim UI, the JSON is already on disk and the HTTP GET
        // serves from cache. Skipped for files with no audio tracks.
        if (probeResult.audioTracks.length > 0) {
            void this.waveformService
                .getOrComputeCached(sessionId, { inputPath: destPath })
                .catch((err) => {
                    this.logger.warn(
                        `Background waveform prime failed for ${sessionId}: ${(err as Error).message}`,
                    );
                });
        }

        // Same for the storyboard: the trim timeline wants frames as soon as it
        // opens, and generating them takes an ffmpeg pass over the whole file.
        const video = probeResult.videoTracks[0];
        const duration = probeResult.format?.duration ?? 0;
        if (video?.width && video?.height && duration > 0) {
            void this.thumbnailService
                .getOrGeneratePreview(sessionId, {
                    inputPath: destPath,
                    duration,
                    sourceWidth: video.width,
                    sourceHeight: video.height,
                })
                .catch((err) => {
                    this.logger.warn(
                        `Background storyboard prime failed for ${sessionId}: ${(err as Error).message}`,
                    );
                });
        }

        this.logger.log(
            `Ingest complete for session ${sessionId}: ` +
                `${probeResult.videoTracks.length} video, ` +
                `${probeResult.audioTracks.length} audio track(s)`,
        );
    }

    private sendStatusWebhook(sessionId: string, status: string): void {
        const session = this.sessionService.get(sessionId);
        if (!session?.config.webhook?.url) return;

        this.webhookService
            .send(session.config.webhook.url, session.config.webhook.sessionToken || '', {
                sessionId,
                status: status as any,
            })
            .catch(() => {});
    }
}
