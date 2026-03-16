import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import { TusdServer } from 'node-tusd';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { rename, copyFile, unlink, mkdir } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
const EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class TusUploadService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TusUploadService.name);
    private tusdServer!: TusdServer;
    private readonly tusDir: string;
    private readonly workDir: string;

    constructor(
        private readonly sessionService: SessionService,
        private readonly probeService: ProbeService,
    ) {
        this.workDir = process.env.WORK_DIR || join(process.cwd(), 'work');
        this.tusDir = join(this.workDir, '.tus-uploads');
        mkdirSync(this.tusDir, { recursive: true });
    }

    async onModuleInit(): Promise<void> {
        const maxSize =
            parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) ||
            DEFAULT_MAX_SIZE;
        const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';

        this.tusdServer = new TusdServer({
            path: '/api/tus',
            directory: this.tusDir,
            maxSize,
            expirationMs: EXPIRATION_MS,
            allowedOrigins: [corsOrigin],
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

                this.sessionService.updateStatus(sessionId, 'uploading');
            },

            onUploadFinish: async (_req, upload) => {
                const sessionId = upload.metadata?.sessionId;
                if (!sessionId) {
                    // Partial upload completed — nothing to do
                    return;
                }

                const filename = upload.metadata?.filename || 'input';
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

                this.sessionService.setFilePath(sessionId, destPath);

                const probeResult = await this.probeService.probe(destPath);

                this.sessionService.setProbeResult(sessionId, probeResult);
                this.sessionService.updateStatus(sessionId, 'uploaded');

                this.logger.log(
                    `Upload complete for session ${sessionId}: ` +
                        `${probeResult.videoTracks.length} video, ` +
                        `${probeResult.audioTracks.length} audio track(s)`,
                );
            },
        });

        await this.tusdServer.start();

        this.logger.log(
            `TUS server initialised (maxSize: ${maxSize} bytes, expiration: ${EXPIRATION_MS / 1000}s)`,
        );
    }

    async onModuleDestroy(): Promise<void> {
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
}
