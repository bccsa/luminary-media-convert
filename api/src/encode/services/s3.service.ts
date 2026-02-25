import { Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { readdirSync, statSync } from 'fs';
import { join, relative, posix } from 'path';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';

export interface S3UploadResult {
    keys: string[];
    masterPlaylistKey: string;
}

@Injectable()
export class S3Service {
    private readonly logger = new Logger(S3Service.name);

    /**
     * Create a MinIO client from the session's S3 configuration.
     */
    private createClient(config: S3ConfigDto): Minio.Client {
        return new Minio.Client({
            endPoint: config.endPoint,
            port: config.port,
            useSSL: config.useSSL ?? true,
            accessKey: config.accessKey,
            secretKey: config.secretKey,
            region: config.region,
        });
    }

    /**
     * Recursively collect all file paths under a directory.
     */
    private walkDir(dir: string): string[] {
        const results: string[] = [];
        const entries = readdirSync(dir);

        for (const entry of entries) {
            const fullPath = join(dir, entry);
            const stat = statSync(fullPath);
            if (stat.isDirectory()) {
                results.push(...this.walkDir(fullPath));
            } else {
                results.push(fullPath);
            }
        }

        return results;
    }

    /**
     * Upload all files from the output directory to S3.
     * Returns the list of uploaded object keys and the master playlist key.
     * Optionally reports progress as each file completes (0-100%).
     */
    async uploadDirectory(
        config: S3ConfigDto,
        outputDir: string,
        masterPlaylistFilename: string,
        options?: { onProgress?: (percent: number) => void }
    ): Promise<S3UploadResult> {
        const client = this.createClient(config);
        const files = this.walkDir(outputDir);
        const totalFiles = files.length;
        const keys: string[] = [];
        let masterPlaylistKey = '';

        const prefix = config.pathPrefix
            ? config.pathPrefix.replace(/\/+$/, '')
            : '';

        for (const filePath of files) {
            const relativePath = relative(outputDir, filePath);
            // Use posix separators for S3 object keys
            const objectKey = prefix
                ? posix.join(prefix, relativePath.split(/[\\/]/).join('/'))
                : relativePath.split(/[\\/]/).join('/');

            const contentType = this.getContentType(filePath);

            try {
                await client.fPutObject(
                    config.bucket,
                    objectKey,
                    filePath,
                    { 'Content-Type': contentType }
                );
                keys.push(objectKey);

                if (relativePath === masterPlaylistFilename) {
                    masterPlaylistKey = objectKey;
                }

                const percent =
                    totalFiles > 0
                        ? Math.round((keys.length / totalFiles) * 100)
                        : 100;
                options?.onProgress?.(Math.min(percent, 100));

                this.logger.debug(`Uploaded: ${objectKey}`);
            } catch (err) {
                throw new Error(
                    `S3 upload failed for ${objectKey}: ${(err as Error).message}`
                );
            }
        }

        this.logger.log(
            `Uploaded ${keys.length} file(s) to s3://${config.bucket}/${prefix || ''}`
        );

        return { keys, masterPlaylistKey };
    }

    private getContentType(filePath: string): string {
        if (filePath.endsWith('.m3u8'))
            return 'application/vnd.apple.mpegurl';
        if (filePath.endsWith('.m4s')) return 'video/iso.segment';
        if (filePath.endsWith('.mp4')) return 'video/mp4';
        return 'application/octet-stream';
    }
}
