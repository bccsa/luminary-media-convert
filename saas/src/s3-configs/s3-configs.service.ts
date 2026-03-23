import {
    Injectable,
    NotFoundException,
    ForbiddenException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service.js';
import { CryptoService } from '../crypto/crypto.service.js';
import { S3ConfigDocument } from './interfaces/s3-config-document.interface.js';
import { CreateS3ConfigDto } from './dto/create-s3-config.dto.js';
import { UpdateS3ConfigDto } from './dto/update-s3-config.dto.js';

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
