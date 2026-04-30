import {
    BadGatewayException,
    ConflictException,
    HttpException,
    Injectable,
    Logger,
} from '@nestjs/common';
import type { HlsMedia, HlsParsedMaster, HlsVariant } from '@luminary-media-converter/hls';

export interface S3ConfigPayload {
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    bucket: string;
    region?: string;
    accessKey: string;
    secretKey: string;
    pathPrefix?: string;
}

export interface HlsReadResult {
    master: HlsParsedMaster;
    etag: string;
    folderPrefix: string;
    masterPlaylistKey: string;
}

export interface HlsMutateOperation {
    type: string;
    language?: string;
    name?: string;
    vttBase64?: string;
    default?: boolean;
    forced?: boolean;
}

export interface HlsMutateResult {
    master: HlsParsedMaster;
    etag: string;
    writtenKeys: string[];
}

export interface HlsDiscoverResult {
    masterPlaylistKey: string;
    folderPrefix: string;
    anglePlaylists?: Array<{ name: string; key: string }>;
    chaptersLanguages?: string[];
}

export interface HlsChaptersReadResult {
    vtt: string;
}

/**
 * Thin HTTP client for the Encoding API's /api/hls/* endpoints.
 * Auth uses the same `ENCODING_API_MASTER_KEY` already used for session create.
 */
@Injectable()
export class HlsEditClient {
    private readonly logger = new Logger(HlsEditClient.name);
    private readonly baseUrl: string;
    private readonly masterKey: string;

    constructor() {
        this.baseUrl = process.env.ENCODING_API_URL ?? '';
        this.masterKey = process.env.ENCODING_API_MASTER_KEY ?? '';
    }

    async read(s3: S3ConfigPayload, masterPlaylistKey: string): Promise<HlsReadResult> {
        return this.post<HlsReadResult>('/api/hls/read', { s3, masterPlaylistKey });
    }

    async mutate(
        s3: S3ConfigPayload,
        masterPlaylistKey: string,
        ifMatch: string,
        operations: HlsMutateOperation[],
    ): Promise<HlsMutateResult> {
        return this.post<HlsMutateResult>('/api/hls/mutate', {
            s3, masterPlaylistKey, ifMatch, operations,
        });
    }

    async discover(
        s3: S3ConfigPayload,
        opts: { masterPlaylistKey?: string; folderPrefix?: string },
    ): Promise<HlsDiscoverResult> {
        return this.post<HlsDiscoverResult>('/api/hls/discover', { s3, ...opts });
    }

    /**
     * Returns null when the chapter file is not present (Encoding API responds 404).
     */
    async readChapters(
        s3: S3ConfigPayload,
        folderPrefix: string,
        lang: string,
    ): Promise<HlsChaptersReadResult | null> {
        try {
            return await this.post<HlsChaptersReadResult>('/api/hls/chapters/read', {
                s3, folderPrefix, lang,
            });
        } catch (err) {
            if (err instanceof HttpException && err.getStatus() === 404) return null;
            throw err;
        }
    }

    async writeChapters(
        s3: S3ConfigPayload,
        folderPrefix: string,
        lang: string,
        vtt: string,
    ): Promise<void> {
        await this.post<void>('/api/hls/chapters/write', { s3, folderPrefix, lang, vtt });
    }

    private async post<T>(path: string, body: unknown): Promise<T> {
        if (!this.baseUrl || !this.masterKey) {
            throw new BadGatewayException(
                'ENCODING_API_URL / ENCODING_API_MASTER_KEY not configured',
            );
        }

        const res = await fetch(`${this.baseUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': this.masterKey,
            },
            body: JSON.stringify(body),
        });

        if (!res.ok) {
            const payload = await res.json().catch(() => ({}));
            const message = (payload as { message?: string }).message ?? `Encoding API returned ${res.status}`;
            this.logger.warn(`HLS ${path} failed (${res.status}): ${message}`);

            // Preserve 409 Conflict semantics from /api/hls/mutate so the SaaS
            // client can re-read and retry.
            if (res.status === 409) {
                throw new ConflictException(payload);
            }
            if (res.status === 400 || res.status === 404 || res.status === 501) {
                throw new HttpException(payload, res.status);
            }
            throw new BadGatewayException(message);
        }

        if (res.status === 204 || res.headers.get('content-length') === '0') {
            return undefined as unknown as T;
        }
        return res.json() as Promise<T>;
    }
}

// Re-export shared types for convenience
export type { HlsMedia, HlsVariant, HlsParsedMaster };
