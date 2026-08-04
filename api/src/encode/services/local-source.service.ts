import { Injectable, Logger } from '@nestjs/common';
import { realpath, stat } from 'fs/promises';
import { basename, delimiter, isAbsolute, join, relative, resolve } from 'path';
import { SessionService } from './session.service.js';
import { TusUploadService } from './tus-upload.service.js';
import { WebhookService } from './webhook.service.js';
import { hasAllowedExtension } from './media-extensions.js';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB

/**
 * Ingests a source file that already exists on the encoder host, without
 * copying it.
 *
 * The tus and URL paths both write the source into WORK_DIR/<sessionId>/ and
 * own it from then on. Here the file belongs to the user and merely happens to
 * be reachable, so this service never writes to it, never moves it, and — most
 * importantly — never deletes it, including on failure. That last point is the
 * one real divergence from UrlFetchService, whose failure path unlinks the
 * partial download it created.
 *
 * Disabled unless ALLOW_LOCAL_SOURCE=true, because an endpoint that takes a
 * filesystem path is a read primitive for anything the encoder process can
 * open: probe, preview and waveform would all happily serve it back. It is
 * meant for the desktop build, where the encoder runs on the user's own machine
 * as the user. LOCAL_SOURCE_ROOTS narrows it further.
 */
@Injectable()
export class LocalSourceService {
    private readonly logger = new Logger(LocalSourceService.name);
    private readonly workDir: string;
    private readonly maxSize: number;
    readonly enabled: boolean;
    /** Optional containment: resolved sources must sit under one of these. */
    private readonly allowedRoots: string[];

    constructor(
        private readonly sessionService: SessionService,
        private readonly tusUploadService: TusUploadService,
        private readonly webhookService: WebhookService
    ) {
        this.workDir = process.env.WORK_DIR || join(process.cwd(), 'work');
        this.maxSize =
            parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) ||
            DEFAULT_MAX_SIZE;
        this.enabled = process.env.ALLOW_LOCAL_SOURCE === 'true';
        this.allowedRoots = (process.env.LOCAL_SOURCE_ROOTS || '')
            .split(delimiter)
            .map((root) => root.trim())
            .filter((root) => root.length > 0)
            .map((root) => resolve(root));
    }

    /**
     * Adopt an on-disk file as the session's source and run the shared
     * post-ingest pipeline. Runs in the background — the caller should not
     * await it.
     */
    async ingest(sessionId: string, requestedPath: string): Promise<void> {
        this.sessionService.updateStatus(sessionId, 'uploading');
        this.sendStatusWebhook(sessionId, 'uploading');

        try {
            const sourcePath = await this.resolveSource(requestedPath);
            const { size } = await stat(sourcePath);
            this.sessionService.setIngestTotal(sessionId, size);

            this.logger.log(
                `Local source adopted for session ${sessionId}: ${sourcePath} (${size} bytes)`
            );

            // Straight to the shared seam: there is nothing to transfer, so the
            // session goes from 'uploading' to 'uploaded' as fast as ffprobe runs.
            await this.tusUploadService.finalizeUpload(sessionId, sourcePath);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `Local source ingest failed for session ${sessionId}: ${message}`
            );
            // Deliberately no unlink here — the file is the user's, not ours.
            this.sessionService.setFailed(sessionId, message);
            this.sendStatusWebhook(sessionId, 'failed', message);
        }
    }

    /**
     * Canonicalise and vet a requested path. Throws with a user-facing reason.
     *
     * realpath() first so that every later check sees the true target rather
     * than a symlink pointing somewhere else.
     */
    private async resolveSource(requestedPath: string): Promise<string> {
        if (!isAbsolute(requestedPath)) {
            throw new Error('Source path must be absolute');
        }

        let sourcePath: string;
        try {
            sourcePath = await realpath(requestedPath);
        } catch {
            throw new Error('Source file does not exist');
        }

        const info = await stat(sourcePath);
        if (!info.isFile()) {
            throw new Error('Source path is not a regular file');
        }

        // Both sides of a containment check must be in the same canonical form.
        // sourcePath has been through realpath, so the boundaries have to be
        // too — otherwise a symlinked ancestor (macOS puts temp dirs under
        // /var, a link to /private/var) makes every comparison meaningless.
        const workDir = await this.canonicalise(this.workDir);

        // A source inside WORK_DIR would sit in the same tree the encoder
        // creates, cleans and deletes per session — including its own output.
        if (this.isInside(workDir, sourcePath)) {
            throw new Error(
                'Source path must be outside the encoder work directory'
            );
        }

        if (this.allowedRoots.length > 0) {
            const roots = await Promise.all(
                this.allowedRoots.map((root) => this.canonicalise(root))
            );
            if (!roots.some((root) => this.isInside(root, sourcePath))) {
                throw new Error(
                    'Source path is outside the permitted directories'
                );
            }
        }

        if (!hasAllowedExtension(basename(sourcePath))) {
            throw new Error(`Unsupported file type: ${basename(sourcePath)}`);
        }

        if (info.size === 0) {
            throw new Error('Source file is empty');
        }

        if (info.size > this.maxSize) {
            throw new Error(
                `Source file is ${info.size} bytes, which exceeds the ${this.maxSize} byte limit`
            );
        }

        return sourcePath;
    }

    /**
     * Resolve a boundary directory to its canonical form, tolerating one that
     * does not exist yet — an absolute path is still a usable comparison base.
     */
    private async canonicalise(dir: string): Promise<string> {
        try {
            return await realpath(dir);
        } catch {
            return resolve(dir);
        }
    }

    /** True when `target` sits strictly inside `root`. */
    private isInside(root: string, target: string): boolean {
        const rel = relative(resolve(root), resolve(target));
        return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
    }

    private sendStatusWebhook(
        sessionId: string,
        status: 'uploading' | 'failed',
        error?: string
    ): void {
        const session = this.sessionService.get(sessionId);
        if (!session?.config.webhook?.url) return;

        this.webhookService
            .send(
                session.config.webhook.url,
                session.config.webhook.sessionToken || '',
                { sessionId, status, error }
            )
            .catch(() => {});
    }
}
