import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { open, mkdir, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { basename, join, extname } from 'path';
import { Readable } from 'stream';
import { SessionService } from './session.service.js';
import { TusUploadService } from './tus-upload.service.js';
import { WebhookService } from './webhook.service.js';
import {
    hasAllowedExtension,
    extensionFromContentType,
} from './media-extensions.js';

const DEFAULT_MAX_SIZE = 10 * 1024 * 1024 * 1024; // 10 GB
const DEFAULT_STREAMS = 4;
const MAX_STREAMS = 16;
const MIN_PARALLEL_BYTES = 16 * 1024 * 1024; // 16 MB
const PROGRESS_INTERVAL_MS = 500;
const HEARTBEAT_INTERVAL_MS = 2000;
const PROBE_TIMEOUT_MS = 15_000;

// Block only cloud metadata endpoints — same policy as WebhookService.
const BLOCKED_HOSTNAME_PATTERNS = [
    /^169\.254\./,
    /^\[fe80:/i,
];

function isBlockedHostname(hostname: string): boolean {
    return BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(hostname));
}

interface ProbeInfo {
    finalUrl: string;
    contentLength: number | null;
    rangeSupported: boolean;
    contentDisposition: string | null;
    contentType: string | null;
}

@Injectable()
export class UrlFetchService {
    private readonly logger = new Logger(UrlFetchService.name);
    private readonly workDir: string;
    private readonly maxSize: number;
    private readonly streams: number;
    private readonly inFlight = new Map<string, AbortController>();

    constructor(
        private readonly sessionService: SessionService,
        private readonly tusUploadService: TusUploadService,
        private readonly webhookService: WebhookService,
    ) {
        this.workDir = process.env.WORK_DIR || join(process.cwd(), 'work');
        this.maxSize =
            parseInt(process.env.MAX_UPLOAD_SIZE || '0', 10) ||
            DEFAULT_MAX_SIZE;
        const requested = parseInt(
            process.env.URL_FETCH_STREAMS || String(DEFAULT_STREAMS),
            10,
        );
        this.streams = Math.max(
            1,
            Math.min(MAX_STREAMS, Number.isFinite(requested) ? requested : DEFAULT_STREAMS),
        );
    }

    /**
     * Cancel an in-flight URL download for the given session, if any.
     * Used by the session DELETE handler.
     */
    abort(sessionId: string): boolean {
        const controller = this.inFlight.get(sessionId);
        if (!controller) return false;
        controller.abort();
        return true;
    }

    /**
     * Fetch a remote HTTP/S URL into the session's work directory and run the
     * shared post-ingest pipeline. Runs in the background — the caller should
     * not await it.
     */
    async fetchToSession(
        sessionId: string,
        url: string,
        suggestedFilename?: string,
    ): Promise<void> {
        const controller = new AbortController();
        this.inFlight.set(sessionId, controller);

        this.sessionService.updateStatus(sessionId, 'uploading');
        this.sendStatusWebhook(sessionId, 'uploading');

        let destPath: string | null = null;
        try {
            await this.validateUrl(url);

            const probe = await this.probe(url, controller.signal);
            await this.validateUrl(probe.finalUrl);

            const filename = this.deriveFilename(
                probe.finalUrl,
                probe.contentDisposition,
                probe.contentType,
                suggestedFilename,
            );

            if (!hasAllowedExtension(filename)) {
                throw new Error(
                    `Unsupported file type for "${filename}". Allowed: media files (video/audio).`,
                );
            }

            if (probe.contentLength !== null && probe.contentLength > this.maxSize) {
                throw new Error(
                    `Source file size (${probe.contentLength} bytes) exceeds the maximum allowed (${this.maxSize} bytes).`,
                );
            }

            if (probe.contentLength !== null) {
                this.sessionService.setIngestTotal(sessionId, probe.contentLength);
            }

            const sessionDir = join(this.workDir, sessionId);
            await mkdir(sessionDir, { recursive: true });
            destPath = join(sessionDir, filename);

            const total = probe.contentLength;
            const useParallel =
                total !== null &&
                total > MIN_PARALLEL_BYTES &&
                probe.rangeSupported &&
                this.streams > 1;

            this.logger.log(
                `URL ingest start for session ${sessionId}: ${probe.finalUrl} ` +
                    `(${total ?? 'unknown'} bytes, ${useParallel ? `${this.streams} streams` : 'single stream'})`,
            );

            if (useParallel) {
                await this.downloadParallel(
                    sessionId,
                    probe.finalUrl,
                    destPath,
                    total!,
                    controller.signal,
                );
            } else {
                await this.downloadSingle(
                    sessionId,
                    probe.finalUrl,
                    destPath,
                    total,
                    controller.signal,
                );
            }

            this.inFlight.delete(sessionId);
            await this.tusUploadService.finalizeUpload(sessionId, destPath);
        } catch (err) {
            this.inFlight.delete(sessionId);
            const message =
                err instanceof Error ? err.message : String(err);
            this.logger.warn(
                `URL ingest failed for session ${sessionId}: ${message}`,
            );
            if (destPath) {
                await unlink(destPath).catch(() => {});
            }
            this.sessionService.setFailed(sessionId, message);
            this.sendStatusWebhook(sessionId, 'failed', message);
        }
    }

    private async validateUrl(url: string): Promise<void> {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw new Error(`Invalid URL: ${url}`);
        }

        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            throw new Error(
                `Unsupported URL protocol "${parsed.protocol}" — only http/https are allowed.`,
            );
        }

        if (isBlockedHostname(parsed.hostname)) {
            throw new Error(
                `URL hostname ${parsed.hostname} is not allowed (cloud metadata endpoint).`,
            );
        }

        try {
            const { address } = await lookup(parsed.hostname);
            if (isBlockedHostname(address)) {
                throw new Error(
                    `URL hostname ${parsed.hostname} resolves to a blocked address (${address}).`,
                );
            }
        } catch (err) {
            // DNS failure: rethrow only if it's our own blocklist error;
            // otherwise let the actual fetch surface a more specific network error.
            if (err instanceof Error && err.message.startsWith('URL hostname')) {
                throw err;
            }
        }
    }

    private async probe(url: string, signal: AbortSignal): Promise<ProbeInfo> {
        const probeSignal = AbortSignal.any([
            signal,
            AbortSignal.timeout(PROBE_TIMEOUT_MS),
        ]);

        // Try HEAD first — most CDNs support it.
        let response: Response | null = null;
        try {
            response = await fetch(url, {
                method: 'HEAD',
                redirect: 'follow',
                signal: probeSignal,
            });
        } catch {
            response = null;
        }

        // Fall back to a tiny ranged GET (e.g. Google Drive rejects HEAD).
        if (!response || !response.ok) {
            response?.body?.cancel?.().catch(() => {});
            response = await fetch(url, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
                redirect: 'follow',
                signal: probeSignal,
            });

            // Discard body — we only want headers.
            response.body?.cancel?.().catch(() => {});

            if (!response.ok && response.status !== 206 && response.status !== 200) {
                throw new Error(
                    `Failed to probe URL: ${response.status} ${response.statusText}`,
                );
            }
        }

        const contentRange = response.headers.get('content-range');
        let contentLength: number | null = null;
        let rangeSupported = false;

        if (contentRange) {
            // Format: bytes 0-0/12345 — proves range support and gives the total.
            const match = /\/(\d+)$/.exec(contentRange);
            if (match) contentLength = parseInt(match[1]!, 10);
            rangeSupported = true;
        }

        if (contentLength === null) {
            const cl = response.headers.get('content-length');
            if (cl) {
                const parsed = parseInt(cl, 10);
                if (Number.isFinite(parsed) && parsed > 0) contentLength = parsed;
            }
        }

        if (!rangeSupported) {
            const acceptRanges = response.headers.get('accept-ranges');
            rangeSupported = acceptRanges?.toLowerCase() === 'bytes';
        }

        return {
            finalUrl: response.url || url,
            contentLength,
            rangeSupported,
            contentDisposition: response.headers.get('content-disposition'),
            contentType: response.headers.get('content-type'),
        };
    }

    private deriveFilename(
        url: string,
        contentDisposition: string | null,
        contentType: string | null,
        suggested?: string,
    ): string {
        if (suggested) {
            const cleaned = basename(suggested.trim());
            if (cleaned) return cleaned;
        }

        if (contentDisposition) {
            // RFC 5987: filename*=UTF-8''encoded
            const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(contentDisposition);
            if (star?.[1]) {
                try {
                    const decoded = decodeURIComponent(star[1].trim());
                    if (decoded) return basename(decoded);
                } catch {
                    // ignore malformed encoding
                }
            }
            // filename="..." or filename=...
            const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(contentDisposition);
            if (plain?.[1]) {
                const cleaned = basename(plain[1].trim());
                if (cleaned) return cleaned;
            }
        }

        try {
            const parsed = new URL(url);
            const path = decodeURIComponent(parsed.pathname);
            const name = basename(path);
            if (name && name !== '/' && extname(name)) return name;
        } catch {
            // ignore
        }

        const ext = extensionFromContentType(contentType) ?? '.mp4';
        return `input${ext}`;
    }

    private async downloadParallel(
        sessionId: string,
        url: string,
        destPath: string,
        total: number,
        signal: AbortSignal,
    ): Promise<void> {
        const fh = await open(destPath, 'w');
        try {
            await fh.truncate(total);
        } catch (err) {
            await fh.close();
            throw err;
        }

        const fd = fh.fd;
        const ranges = this.computeRanges(total, this.streams);
        let downloaded = 0;
        let lastEmittedAt = 0;
        let lastEmittedBytes = 0;

        const emitProgress = (force = false) => {
            const now = Date.now();
            const dt = now - lastEmittedAt;
            const dPercent =
                ((downloaded - lastEmittedBytes) / total) * 100;
            if (force || dt >= PROGRESS_INTERVAL_MS || dPercent >= 2) {
                const percent = Math.min(100, Math.floor((downloaded / total) * 100));
                this.sessionService.updateProgress(sessionId, percent);
                lastEmittedAt = now;
                lastEmittedBytes = downloaded;
            }
        };

        try {
            await Promise.all(
                ranges.map(async ([start, end]) => {
                    const res = await fetch(url, {
                        method: 'GET',
                        headers: { Range: `bytes=${start}-${end}` },
                        redirect: 'follow',
                        signal,
                    });

                    if (res.status !== 206) {
                        throw new Error(
                            `Expected 206 Partial Content, got ${res.status} ${res.statusText}`,
                        );
                    }

                    const contentRange = res.headers.get('content-range');
                    const expected = `bytes ${start}-${end}/`;
                    if (!contentRange || !contentRange.startsWith(expected)) {
                        throw new Error(
                            `Server returned wrong Content-Range: ${contentRange ?? '(none)'}`,
                        );
                    }

                    if (!res.body) {
                        throw new Error('Response has no body');
                    }

                    const counter = new Transform({
                        transform: (chunk, _enc, cb) => {
                            downloaded += chunk.length;
                            emitProgress();
                            cb(null, chunk);
                        },
                    });

                    const writer = createWriteStream(destPath, {
                        fd,
                        start,
                        autoClose: false,
                    });

                    await pipeline(
                        Readable.fromWeb(res.body as any),
                        counter,
                        writer,
                    );
                }),
            );

            emitProgress(true);
            await fh.sync().catch(() => {});
        } finally {
            await fh.close().catch(() => {});
        }

        if (downloaded !== total) {
            throw new Error(
                `Download size mismatch: wrote ${downloaded} bytes, expected ${total}`,
            );
        }
    }

    private async downloadSingle(
        sessionId: string,
        url: string,
        destPath: string,
        total: number | null,
        signal: AbortSignal,
    ): Promise<void> {
        const res = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal,
        });

        if (!res.ok) {
            throw new Error(
                `Fetch failed: ${res.status} ${res.statusText}`,
            );
        }

        if (!res.body) {
            throw new Error('Response has no body');
        }

        let downloaded = 0;
        let lastEmittedAt = 0;
        let lastEmittedBytes = 0;
        let lastHeartbeat = 0;
        const max = this.maxSize;

        const counter = new Transform({
            transform: (chunk, _enc, cb) => {
                downloaded += chunk.length;
                if (downloaded > max) {
                    cb(
                        new Error(
                            `Source file exceeds maximum allowed size (${max} bytes).`,
                        ),
                    );
                    return;
                }

                const now = Date.now();
                if (total !== null) {
                    const dt = now - lastEmittedAt;
                    const dPercent =
                        ((downloaded - lastEmittedBytes) / total) * 100;
                    if (dt >= PROGRESS_INTERVAL_MS || dPercent >= 2) {
                        const percent = Math.min(
                            100,
                            Math.floor((downloaded / total) * 100),
                        );
                        this.sessionService.updateProgress(sessionId, percent);
                        lastEmittedAt = now;
                        lastEmittedBytes = downloaded;
                    }
                } else if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
                    // Unknown total: emit a heartbeat so the SSE stream and
                    // UI know we're still alive. Keep progress at 0.
                    this.sessionService.updateProgress(sessionId, 0);
                    lastHeartbeat = now;
                }
                cb(null, chunk);
            },
        });

        const writer = createWriteStream(destPath);
        await pipeline(Readable.fromWeb(res.body as any), counter, writer);

        if (total !== null) {
            this.sessionService.updateProgress(
                sessionId,
                Math.min(100, Math.floor((downloaded / total) * 100)),
            );
        }
    }

    private computeRanges(total: number, n: number): Array<[number, number]> {
        const ranges: Array<[number, number]> = [];
        const chunkSize = Math.ceil(total / n);
        let start = 0;
        for (let i = 0; i < n && start < total; i++) {
            const end = Math.min(start + chunkSize - 1, total - 1);
            ranges.push([start, end]);
            start = end + 1;
        }
        return ranges;
    }

    private sendStatusWebhook(
        sessionId: string,
        status: string,
        error?: string,
    ): void {
        const session = this.sessionService.get(sessionId);
        if (!session?.config.webhook?.url) return;

        this.webhookService
            .send(session.config.webhook.url, session.config.webhook.sessionToken || '', {
                sessionId,
                status: status as any,
                error,
            })
            .catch(() => {});
    }
}
