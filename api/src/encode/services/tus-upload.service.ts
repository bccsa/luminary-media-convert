import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import { TusdServer } from 'node-tusd';
import { join, basename } from 'path';
import { mkdirSync } from 'fs';
import { rename, copyFile, unlink, mkdir } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';
import { PreviewService } from './preview.service.js';
import { WebhookService } from './webhook.service.js';
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

    constructor(
        private readonly sessionService: SessionService,
        private readonly probeService: ProbeService,
        private readonly previewService: PreviewService,
        private readonly webhookService: WebhookService,
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
                    // Partial uploads (Concatenation extension) lack metadata — allow them
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
            },

            onUploadFinish: async (_req, upload) => {
                const sessionId = upload.metadata?.sessionId;
                if (!sessionId) {
                    // Partial upload completed — nothing to do
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
                try {
                    await rename(tusFilePath, destPath);
                } catch {
                    // Cross-device fallback: copy then delete
                    await copyFile(tusFilePath, destPath);
                    await unlink(tusFilePath);
                }

                // Clean up tusd metadata sidecar (.info file)
                await unlink(`${tusFilePath}.info`).catch(() => {});

                await this.finalizeUpload(sessionId, destPath);
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
