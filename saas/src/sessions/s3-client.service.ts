import { Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
import { S3ConfigsService } from '../s3-configs/s3-configs.service.js';

@Injectable()
export class S3ClientService {
    private readonly logger = new Logger(S3ClientService.name);

    constructor(private readonly s3ConfigsService: S3ConfigsService) {}

    async getObject(
        userId: string,
        s3ConfigId: string,
        key: string,
    ): Promise<Buffer> {
        const { client, bucket } = await this.createClient(
            userId,
            s3ConfigId,
        );

        const stream = await client.getObject(bucket, key);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
            chunks.push(
                Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk),
            );
        }
        return Buffer.concat(chunks);
    }

    async listObjects(
        userId: string,
        s3ConfigId: string,
        prefix: string,
    ): Promise<string[]> {
        const { client, bucket } = await this.createClient(
            userId,
            s3ConfigId,
        );

        return new Promise<string[]>((resolve, reject) => {
            const keys: string[] = [];
            const stream = client.listObjectsV2(bucket, prefix, true);
            stream.on('data', (obj) => {
                if (obj.name) {
                    keys.push(obj.name);
                }
            });
            stream.on('end', () => resolve(keys));
            stream.on('error', (err) => reject(err));
        });
    }

    async deleteObjects(
        userId: string,
        s3ConfigId: string,
        keys: string[],
    ): Promise<number> {
        if (!keys.length) return 0;
        const { client, bucket } = await this.createClient(userId, s3ConfigId);

        await client.removeObjects(bucket, keys);
        this.logger.log(
            `Deleted ${keys.length} object(s) from ${bucket}`,
        );
        return keys.length;
    }

    private async createClient(
        userId: string,
        s3ConfigId: string,
    ): Promise<{ client: Minio.Client; bucket: string }> {
        const config = await this.s3ConfigsService.getById(
            userId,
            s3ConfigId,
        );
        const { accessKey, secretKey } =
            this.s3ConfigsService.decryptCredentials(config);

        const client = new Minio.Client({
            endPoint: config.endPoint,
            port: config.port,
            useSSL: config.useSSL ?? true,
            accessKey,
            secretKey,
            ...(config.region ? { region: config.region } : {}),
        });

        return { client, bucket: config.bucket };
    }
}
