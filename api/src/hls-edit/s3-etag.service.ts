import { ConflictException, Injectable, Logger } from '@nestjs/common';
import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    HeadObjectCommand,
} from '@aws-sdk/client-s3';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';

export interface ObjectWithEtag {
    body: Buffer;
    etag: string;
}

export interface PutResult {
    etag: string;
}

/**
 * S3 helper scoped to hls-edit. Uses @aws-sdk/client-s3 so conditional
 * writes via `If-Match` work across AWS S3, Cloudflare R2, MinIO, and
 * Backblaze B2 (S3 API). The rest of the codebase keeps using minio-js.
 */
@Injectable()
export class S3EtagService {
    private readonly logger = new Logger(S3EtagService.name);

    createClient(config: S3ConfigDto): S3Client {
        const useSSL = config.useSSL ?? true;
        const bareHost = config.endPoint
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '');
        const port = config.port ?? (useSSL ? 443 : 80);
        const endpoint = `${useSSL ? 'https' : 'http'}://${bareHost}:${port}`;

        return new S3Client({
            endpoint,
            region: config.region ?? 'us-east-1',
            credentials: {
                accessKeyId: config.accessKey,
                secretAccessKey: config.secretKey,
            },
            forcePathStyle: true,
        });
    }

    async getObjectWithEtag(
        config: S3ConfigDto,
        key: string
    ): Promise<ObjectWithEtag> {
        const client = this.createClient(config);
        const resp = await client.send(
            new GetObjectCommand({ Bucket: config.bucket, Key: key })
        );
        const body = await streamToBuffer(resp.Body as NodeJS.ReadableStream);
        const etag = stripQuotes(resp.ETag ?? '');
        return { body, etag };
    }

    /**
     * Conditional PUT. Throws ConflictException (HTTP 409) when the
     * upstream ETag no longer matches `ifMatch` (412 PreconditionFailed).
     */
    async putObjectIfMatch(
        config: S3ConfigDto,
        key: string,
        body: Buffer | string,
        ifMatch: string,
        contentType: string
    ): Promise<PutResult> {
        const client = this.createClient(config);
        try {
            const resp = await client.send(
                new PutObjectCommand({
                    Bucket: config.bucket,
                    Key: key,
                    Body: body,
                    ContentType: contentType,
                    IfMatch: ifMatch,
                })
            );
            return { etag: stripQuotes(resp.ETag ?? '') };
        } catch (err) {
            if (isPreconditionFailed(err)) {
                const current = await this.headEtag(
                    client,
                    config.bucket,
                    key
                ).catch(() => undefined);
                throw new ConflictException({
                    message: 'Master playlist was modified since last read',
                    code: 'ETAG_MISMATCH',
                    ...(current ? { currentEtag: current } : {}),
                });
            }
            throw err;
        }
    }

    async putObject(
        config: S3ConfigDto,
        key: string,
        body: Buffer | string,
        contentType: string
    ): Promise<PutResult> {
        const client = this.createClient(config);
        const resp = await client.send(
            new PutObjectCommand({
                Bucket: config.bucket,
                Key: key,
                Body: body,
                ContentType: contentType,
            })
        );
        return { etag: stripQuotes(resp.ETag ?? '') };
    }

    private async headEtag(
        client: S3Client,
        bucket: string,
        key: string
    ): Promise<string> {
        const resp = await client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: key })
        );
        return stripQuotes(resp.ETag ?? '');
    }
}

function stripQuotes(etag: string): string {
    return etag.replace(/^"|"$/g, '');
}

function isPreconditionFailed(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
        Code?: string;
    };
    return (
        e.name === 'PreconditionFailed' ||
        e.Code === 'PreconditionFailed' ||
        e.$metadata?.httpStatusCode === 412
    );
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
