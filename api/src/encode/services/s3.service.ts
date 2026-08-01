import { Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Transform } from 'stream';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';

@Injectable()
export class S3Service {
    private readonly logger = new Logger(S3Service.name);

    /**
     * Create a MinIO client from the session's S3 configuration.
     */
    createClient(config: S3ConfigDto): Minio.Client {
        // MinIO client expects a bare hostname — strip any protocol prefix
        const endPoint = config.endPoint
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '');

        return new Minio.Client({
            endPoint,
            port: config.port,
            useSSL: config.useSSL ?? true,
            accessKey: config.accessKey,
            secretKey: config.secretKey,
            region: config.region,
        });
    }

    /**
     * The prefix as it should appear in an object key: no leading separator, no
     * trailing one, no doubled ones.
     *
     * S3 permits a key to begin with '/', but it is an empty first path segment
     * rather than a root, so nothing addresses it consistently: clients drop it
     * when signing, public URLs render it as '//', and two spellings of one key
     * then disagree about whether they name the same object. A prefix typed as
     * '/videos' produced exactly that — every key led with a slash, delivery URLs
     * carried '//', and renaming the prefix to repair it failed as a copy onto
     * itself. Take the leading separator off here, where keys are built, so it
     * cannot enter storage regardless of how the caller spelled it.
     */
    static canonicalPrefix(pathPrefix?: string): string {
        return (pathPrefix ?? '')
            .replace(/\/{2,}/g, '/')
            .replace(/^\/+/, '')
            .replace(/\/+$/, '');
    }

    /**
     * `onBytes` reports bytes as they leave for S3, not on completion.
     *
     * Callers watching for a stuck upload need to distinguish slow from stalled,
     * and per-file completion cannot: byte-range packing produces files of a few
     * hundred MB, so on a slow link a perfectly healthy transfer reports nothing
     * for minutes. A 500 MB file at 2 MB/s took over four minutes and was killed
     * by a five-minute stall detector that had no way to see it moving.
     */
    async uploadFile(
        client: Minio.Client,
        bucket: string,
        filePath: string,
        objectKey: string,
        onBytes?: (bytes: number) => void,
    ): Promise<void> {
        const contentType = this.getContentType(filePath);

        if (!onBytes) {
            await client.fPutObject(bucket, objectKey, filePath, {
                'Content-Type': contentType,
            });
            this.logger.debug(`Uploaded: ${objectKey}`);
            return;
        }

        const { size } = await stat(filePath);
        const counter = new Transform({
            transform(chunk, _enc, cb) {
                onBytes(chunk.length);
                cb(null, chunk);
            },
        });
        await client.putObject(
            bucket,
            objectKey,
            createReadStream(filePath).pipe(counter),
            size,
            { 'Content-Type': contentType },
        );
        this.logger.debug(`Uploaded: ${objectKey}`);
    }

    getContentType(filePath: string): string {
        if (filePath.endsWith('.m3u8'))
            return 'application/vnd.apple.mpegurl';
        if (filePath.endsWith('.m4s')) return 'video/iso.segment';
        if (filePath.endsWith('.ts')) return 'video/mp2t';
        if (filePath.endsWith('.mp4')) return 'video/mp4';
        if (filePath.endsWith('.webp')) return 'image/webp';
        if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg'))
            return 'image/jpeg';
        if (filePath.endsWith('.vtt')) return 'text/vtt';
        return 'application/octet-stream';
    }
}
