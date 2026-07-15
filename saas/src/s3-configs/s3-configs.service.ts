import {
    Injectable,
    NotFoundException,
    ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as Minio from 'minio';
import { DatabaseService } from '../database/database.service.js';
import { CryptoService } from '../crypto/crypto.service.js';
import { S3ConfigDocument } from './interfaces/s3-config-document.interface.js';
import { CreateS3ConfigDto } from './dto/create-s3-config.dto.js';
import { UpdateS3ConfigDto } from './dto/update-s3-config.dto.js';
import { TestS3ConfigDto } from './dto/test-s3-config.dto.js';

/** Result of a storage connectivity test — surfaced verbatim to the UI. */
export interface S3ConnectivityResult {
    /** True only when the endpoint was reached, auth succeeded, and the bucket exists. */
    ok: boolean;
    /** True when the endpoint host/port responded at all (auth may still have failed). */
    reachable: boolean;
    /** Whether the target bucket exists (only meaningful once reachable + authed). */
    bucketExists?: boolean;
    /** Human-readable, actionable summary. */
    message: string;
}

const TEST_TIMEOUT_MS = 8000;

@Injectable()
export class S3ConfigsService {
    constructor(
        private readonly databaseService: DatabaseService,
        private readonly cryptoService: CryptoService,
    ) {}

    async create(
        userId: string,
        dto: CreateS3ConfigDto,
    ): Promise<S3ConfigDocument> {
        const now = new Date().toISOString();
        const doc: S3ConfigDocument = {
            _id: `s3config:${randomUUID()}`,
            docType: 's3config',
            userId,
            name: dto.name,
            endPoint: dto.endPoint,
            port: dto.port,
            useSSL: dto.useSSL,
            bucket: dto.bucket,
            region: dto.region,
            publicUrl: dto.publicUrl,
            accessKey: this.cryptoService.encrypt(dto.accessKey),
            secretKey: this.cryptoService.encrypt(dto.secretKey),
            createdAt: now,
            updatedAt: now,
        };

        await this.databaseService.insert(doc);
        return doc;
    }

    async list(userId: string): Promise<S3ConfigDocument[]> {
        const result = await this.databaseService.find<S3ConfigDocument>({
            selector: { docType: 's3config', userId },
            use_index: 's3configs-by-user',
            sort: [{ docType: 'desc' as const }, { userId: 'desc' as const }, { createdAt: 'desc' as const }],
            limit: 100,
        });
        return result.docs;
    }

    async getById(
        userId: string,
        configId: string,
    ): Promise<S3ConfigDocument> {
        const doc = await this.getDoc(configId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to access this S3 config');
        }
        return doc;
    }

    async update(
        userId: string,
        configId: string,
        dto: UpdateS3ConfigDto,
    ): Promise<S3ConfigDocument> {
        const doc = await this.getById(userId, configId);
        const now = new Date().toISOString();

        if (dto.name !== undefined) doc.name = dto.name;
        if (dto.endPoint !== undefined) doc.endPoint = dto.endPoint;
        if (dto.port !== undefined) doc.port = dto.port;
        if (dto.useSSL !== undefined) doc.useSSL = dto.useSSL;
        if (dto.bucket !== undefined) doc.bucket = dto.bucket;
        if (dto.region !== undefined) doc.region = dto.region;
        if (dto.publicUrl !== undefined) doc.publicUrl = dto.publicUrl || undefined;

        if (dto.accessKey !== undefined)
            doc.accessKey = this.cryptoService.encrypt(dto.accessKey);
        if (dto.secretKey !== undefined)
            doc.secretKey = this.cryptoService.encrypt(dto.secretKey);
        doc.updatedAt = now;

        await this.databaseService.upsert(doc);
        return doc;
    }

    async remove(userId: string, configId: string): Promise<void> {
        const doc = await this.getById(userId, configId);
        await this.databaseService.destroy(doc._id, doc._rev!);
    }

    decryptCredentials(doc: S3ConfigDocument): { accessKey: string; secretKey: string } {
        return {
            accessKey: this.cryptoService.decrypt(doc.accessKey),
            secretKey: this.cryptoService.decrypt(doc.secretKey),
        };
    }

    /**
     * Test connectivity to an S3-compatible endpoint without persisting anything.
     * Resolves credentials from the payload, falling back to the stored config
     * (edit mode where the secret was not re-typed). Never throws for expected
     * failure modes — returns a structured, UI-friendly result instead.
     */
    async testConnection(
        userId: string,
        dto: TestS3ConfigDto,
    ): Promise<S3ConnectivityResult> {
        let accessKey = dto.accessKey?.trim();
        let secretKey = dto.secretKey?.trim();

        if ((!accessKey || !secretKey) && dto.configId) {
            const doc = await this.getById(userId, dto.configId);
            const creds = this.decryptCredentials(doc);
            if (!accessKey) accessKey = creds.accessKey;
            if (!secretKey) secretKey = creds.secretKey;
        }

        if (!accessKey || !secretKey) {
            return {
                ok: false,
                reachable: false,
                message: 'Missing access key or secret key.',
            };
        }

        // MinIO client expects a bare hostname — strip any protocol/trailing slash.
        const endPoint = dto.endPoint
            .trim()
            .replace(/^https?:\/\//, '')
            .replace(/\/+$/, '');
        const bucket = dto.bucket.trim();

        let client: Minio.Client;
        try {
            client = new Minio.Client({
                endPoint,
                ...(dto.port ? { port: dto.port } : {}),
                useSSL: dto.useSSL ?? true,
                accessKey,
                secretKey,
                ...(dto.region ? { region: dto.region } : {}),
            });
        } catch (err) {
            return {
                ok: false,
                reachable: false,
                message: `Invalid connection settings: ${(err as Error).message}`,
            };
        }

        try {
            const exists = await this.withTimeout(
                client.bucketExists(bucket),
                TEST_TIMEOUT_MS,
            );
            if (exists) {
                return {
                    ok: true,
                    reachable: true,
                    bucketExists: true,
                    message: `Connected. Bucket "${bucket}" is reachable.`,
                };
            }
            return {
                ok: false,
                reachable: true,
                bucketExists: false,
                message: `Connected, but bucket "${bucket}" was not found. Create it or check the name.`,
            };
        } catch (err) {
            return { ok: false, ...this.classifyS3Error(err, bucket) };
        }
    }

    private withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
        let timer: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error('TIMEOUT: no response from endpoint')),
                ms,
            );
        });
        return Promise.race([p, timeout]).finally(() =>
            clearTimeout(timer),
        ) as Promise<T>;
    }

    private classifyS3Error(
        err: unknown,
        bucket: string,
    ): Omit<S3ConnectivityResult, 'ok'> {
        const e = err as { code?: string; message?: string };
        const hay = `${e.code ?? ''} ${e.message ?? String(err)}`;

        if (
            /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH|TIMEOUT/i.test(
                hay,
            )
        ) {
            return {
                reachable: false,
                message:
                    'Could not reach the endpoint. Check the endpoint host/port, and that the storage is reachable from the server — e.g. use host.docker.internal (not localhost) when the app runs in Docker.',
            };
        }
        if (/EPROTO|wrong version number|\bSSL\b|self.signed|CERT_/i.test(hay)) {
            return {
                reachable: true,
                message: `TLS error — check whether "Use SSL" matches the endpoint (${e.message ?? hay}).`,
            };
        }
        if (
            /InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|InvalidRequest|Forbidden/i.test(
                hay,
            )
        ) {
            return {
                reachable: true,
                message:
                    'Reached the storage, but authentication was rejected or access is denied. Check the access key / secret and the bucket permissions.',
            };
        }
        if (/NoSuchBucket|NotFound/i.test(hay)) {
            return {
                reachable: true,
                bucketExists: false,
                message: `Connected, but bucket "${bucket}" was not found.`,
            };
        }
        return {
            reachable: false,
            message: `Connection failed: ${e.message ?? String(err)}`,
        };
    }

    private async getDoc(configId: string): Promise<S3ConfigDocument> {
        const docId = configId.startsWith('s3config:')
            ? configId
            : `s3config:${configId}`;
        try {
            return await this.databaseService.get<S3ConfigDocument>(docId);
        } catch (err: any) {
            if (err.statusCode === 404) {
                throw new NotFoundException(`S3 config ${configId} not found`);
            }
            throw err;
        }
    }
}
