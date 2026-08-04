import {
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
// Type-only: node-tusd is ESM and this service compiles to CommonJS, so the
// implementation is pulled in via a dynamic import() below — and only when tus
// is actually enabled. That keeps the tusd Go binary out of builds that never
// serve uploads (the desktop app reads its source straight off local disk).
import type { TusdServer } from 'node-tusd';
import { join, basename } from 'path';
import { mkdirSync } from 'fs';
import { rename, copyFile, unlink, mkdir, access, stat, readdir, readFile } from 'fs/promises';
import type { IncomingMessage, ServerResponse } from 'http';
import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';
import { PreviewService } from './preview.service.js';
import { WebhookService } from './webhook.service.js';
import { WaveformService } from './waveform.service.js';
import { ThumbnailService } from './thumbnail.service.js';
import { hasAllowedExtension } from './media-extensions.js';
import { ingestShortfall, inFlightShortfall } from './disk-space.js';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
const EXPIRATION_MS = 10 * 60 * 1000; // 10 minutes
/**
 * How often the volume is measured while uploads are running.
 *
 * tusd reports progress roughly every second per upload, and the client runs
 * five in parallel — checking on every event would be several statfs calls a
 * second for no better answer.
 */
const DISK_CHECK_INTERVAL_MS = 2000;

@Injectable()
export class TusUploadService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(TusUploadService.name);
    private tusdServer!: TusdServer;
    private readonly tusDir: string;
    private readonly workDir: string;
    /**
     * Whether this instance serves tus uploads. Off means no tusd process, no
     * /api/tus routes, and no staging directory; ingestion then comes from URL
     * fetch or a local source path instead. finalizeUpload() stays available
     * either way — every ingestion path converges on it.
     */
    readonly tusEnabled: boolean;
    private cleanupInterval: ReturnType<typeof setInterval> | null = null;
    /**
     * Staged finals we have already failed to rescue, by upload id.
     *
     * The sweep below runs on a timer, so a permanently broken upload would
     * otherwise be retried until the process ends.
     */
    private readonly reconcileFailures = new Map<string, number>();
    private sweepInterval: ReturnType<typeof setInterval> | null = null;
    /** When the volume was last measured, for the progress-hook throttle. */
    private lastDiskCheck = 0;

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
        this.tusEnabled = process.env.TUS_ENABLED !== 'false';
        if (this.tusEnabled) {
            mkdirSync(this.tusDir, { recursive: true });
        }
    }

    async onModuleInit(): Promise<void> {
        if (!this.tusEnabled) {
            this.logger.log('TUS uploads disabled (TUS_ENABLED=false)');
            return;
        }

        // Deferred so the ESM-only node-tusd package — and the platform-specific
        // tusd binary it resolves — are never loaded when uploads are disabled.
        const { TusdServer } = await import('node-tusd');

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

                // A session stopped mid-upload must stay stopped. tusd's
                // StopUpload only cuts a request already in flight, so a client
                // sending small chunks with gaps between them would otherwise
                // carry on filling the disk one accepted chunk at a time.
                if (session.status === 'failed') {
                    throw {
                        status_code: 507,
                        body: session.error || 'This upload has been stopped.',
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

                // Refuse now rather than after the transfer. `filesize` carries
                // the whole file: with parallelUploads > 1 this hook fires once
                // per partial, each declaring only its own slice, so
                // `upload.size` alone would wave through a file five times too
                // big for the volume. Older clients omit it — then the partial
                // size is all there is, which still catches the worst cases.
                const shortfall = await ingestShortfall(
                    this.workDir,
                    Number(upload.metadata?.filesize) || upload.size || 0,
                );
                if (shortfall) {
                    this.logger.error(
                        `Upload refused for session ${sessionId}: ${shortfall}`,
                    );
                    throw { status_code: 507, body: shortfall };
                }

                this.sessionService.updateStatus(sessionId, 'uploading');
                this.sendStatusWebhook(sessionId, 'uploading');
            },

            onProgress: async (upload) => {
                const sessionId = upload.metadata?.sessionId;
                if (!sessionId) return;

                // Only judge uploads still running: a session already failed or
                // finished has nothing to stop, and re-failing it would overwrite
                // whatever actually went wrong.
                const session = this.sessionService.get(sessionId);
                if (!session || session.status !== 'uploading') return;

                // Bytes are arriving, so this session is alive. Stamped before
                // the throttle below, and regardless of it — the abandoned-session
                // sweep judges on this and a slow upload must not look idle.
                this.sessionService.touch(sessionId);

                const now = Date.now();
                if (now - this.lastDiskCheck < DISK_CHECK_INTERVAL_MS) return;
                this.lastDiskCheck = now;

                const remaining = Math.max(
                    0,
                    (upload.size ?? 0) - (upload.offset ?? 0),
                );
                const shortfall = await inFlightShortfall(
                    this.workDir,
                    remaining,
                );
                if (!shortfall) return;

                this.logger.error(
                    `Upload for session ${sessionId} stopped: ${shortfall}`,
                );
                this.sessionService.setFailed(sessionId, shortfall);
                this.sendStatusWebhook(sessionId, 'failed');

                // Throwing asks tusd to terminate the upload rather than letting
                // it carry on filling a volume that has no room left.
                throw { status_code: 507, body: shortfall };
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
            },
        });

        await this.tusdServer.start();

        // Schedule periodic cleanup every 30 minutes
        this.sweepInterval = setInterval(() => {
            void this.sweepStagedFinals();
        }, 5_000);
        this.sweepInterval.unref?.();

        this.cleanupInterval = setInterval(() => {
            // Rescue before expiring: a finished upload waiting on a dead hook is
            // not abandoned, and deleting it destroys the user's file.
            void this.sweepStagedFinals().finally(() => {
            this.tusdServer.cleanUpExpiredUploads().then((count) => {
                if (count > 0) {
                    this.logger.log(`Periodic cleanup: removed ${count} expired upload(s)`);
                }
            }).catch((err) => {
                this.logger.warn(`Periodic cleanup failed: ${(err as Error).message}`);
            });
            });
        }, 30 * 60 * 1000);

        this.logger.log(
            `TUS server initialised (maxSize: ${maxSize} bytes, expiration: ${EXPIRATION_MS / 1000}s)`,
        );
    }

    async onModuleDestroy(): Promise<void> {
        if (!this.tusEnabled) return;

        if (this.sweepInterval) {
            clearInterval(this.sweepInterval);
            this.sweepInterval = null;
        }
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }

        try {
            // Before expiring anything: a deploy restart ran this while a
            // finished upload sat in staging waiting on a hook that had been
            // killed, and expiry deleted the file outright.
            await this.sweepStagedFinals();
        } catch (err) {
            this.logger.warn(
                `Final sweep before shutdown failed: ${(err as Error).message}`,
            );
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
        if (!this.tusEnabled) {
            // The routes are not mounted when tus is disabled, so this is only
            // reachable if something calls in directly. Fail loudly rather than
            // dereferencing a server that was never started.
            res.statusCode = 404;
            res.end();
            return;
        }
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
    /**
     * Finalise uploads that completed but whose post-finish hook never ran.
     *
     * tusd delivers that hook on a request whose context it ties to the client's
     * connection, and the browser closes it the moment it has its 201 — four of
     * six real uploads lost that race. The first attempt at a rescue registered
     * the expected upload from the post-create hook, but that payload carries no
     * id for a concatenated final, so it watched a path that could never exist.
     *
     * So trust the filesystem instead of any hook. Every staged upload has an
     * `.info` sidecar holding its id, declared size and sessionId; an upload
     * whose data file has reached that size, for a session still without a
     * filePath, is a completed upload nobody has processed. That is true whether
     * the hook was killed a second ago or before this code was deployed.
     */
    private async sweepStagedFinals(): Promise<void> {
        let entries: string[];
        try {
            entries = await readdir(this.tusDir);
        } catch {
            return; // Staging directory not created yet.
        }

        for (const name of entries) {
            if (!name.endsWith('.info')) continue;

            let info: {
                ID?: string;
                Size?: number;
                IsPartial?: boolean;
                MetaData?: Record<string, string>;
            };
            try {
                info = JSON.parse(
                    await readFile(join(this.tusDir, name), 'utf-8'),
                );
            } catch {
                continue; // Half-written sidecar; it will be read next sweep.
            }

            // Partials are concatenated into a final; only the final is a source.
            if (info.IsPartial) continue;

            const sessionId = info.MetaData?.sessionId;
            const uploadId = info.ID || name.replace(/\.info$/, '');
            if (!sessionId || !info.Size) continue;
            if ((this.reconcileFailures.get(uploadId) ?? 0) >= 3) continue;

            const session = this.sessionService.get(sessionId);
            // No session, or the hook already did the work: nothing to rescue.
            if (!session || session.filePath) continue;
            // A restart marks anything in flight as failed, which would hide a
            // perfectly complete upload from this sweep for good. That marker is
            // ours and specific, so treat it as rescuable; any other failure is
            // a real one and stays failed.
            const failedByRestart =
                session.status === 'failed' &&
                /encoder restarted/i.test(session.error ?? '');
            if (
                session.status !== 'uploading' &&
                session.status !== 'created' &&
                !failedByRestart
            ) {
                continue;
            }

            const tusFilePath = join(this.tusDir, uploadId);
            let size: number;
            try {
                size = (await stat(tusFilePath)).size;
            } catch {
                continue; // Still being concatenated.
            }
            if (size !== info.Size) continue;

            this.logger.warn(
                `post-finish hook never ran for upload ${uploadId}; finalising session ${sessionId} from staged file`,
            );
            try {
                await this.finalizeStagedUpload(
                    tusFilePath,
                    sessionId,
                    basename(info.MetaData?.filename || 'input') || 'input',
                );
            } catch (err) {
                this.reconcileFailures.set(
                    uploadId,
                    (this.reconcileFailures.get(uploadId) ?? 0) + 1,
                );
                this.logger.error(
                    `Reconciling upload ${uploadId} failed: ${(err as Error).message}`,
                );
            }
        }
    }

    /** The move-and-finalise the post-finish hook would have done. */
    private async finalizeStagedUpload(
        tusFilePath: string,
        sessionId: string,
        filename: string,
    ): Promise<void> {
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
