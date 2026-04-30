import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    ConflictException,
    Logger,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service.js';
import { ApiKeyDocument } from './interfaces/api-key-document.interface.js';

@Injectable()
export class KeysService {
    private readonly logger = new Logger(KeysService.name);

    constructor(private readonly databaseService: DatabaseService) {}

    async createKey(
        userId: string,
        name: string,
        keyHash: string,
        prefix: string,
    ): Promise<ApiKeyDocument> {
        const now = new Date().toISOString();

        const doc: ApiKeyDocument = {
            _id: `apikey:${randomUUID()}`,
            docType: 'apikey',
            userId,
            name,
            prefix,
            keyHash,
            status: 'active',
            createdAt: now,
            updatedAt: now,
        };

        await this.databaseService.insert(doc);

        this.logger.log(
            `API key '${name}' (${prefix}...) created for user ${userId}`,
        );

        return doc;
    }

    async listKeys(userId: string): Promise<ApiKeyDocument[]> {
        const result = await this.databaseService.find<ApiKeyDocument>({
            selector: { docType: 'apikey', userId },
            use_index: 'apikeys-by-user',
            sort: [{ createdAt: 'desc' as const }],
            limit: 100,
        });

        return result.docs;
    }

    async revokeKey(userId: string, keyId: string): Promise<ApiKeyDocument> {
        const doc = await this.getKeyDoc(keyId);

        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to revoke this key');
        }

        if (doc.status === 'revoked') {
            throw new ConflictException('Key is already revoked');
        }

        const now = new Date().toISOString();
        const updated: ApiKeyDocument = {
            ...doc,
            status: 'revoked',
            revokedAt: now,
            updatedAt: now,
        };

        const response = await this.databaseService.upsert(updated);
        updated._rev = response.rev;

        this.logger.log(`API key ${keyId} revoked by user ${userId}`);

        return updated;
    }

    async adminRevokeKey(keyId: string): Promise<ApiKeyDocument> {
        const doc = await this.getKeyDoc(keyId);

        if (doc.status === 'revoked') {
            throw new ConflictException('Key is already revoked');
        }

        const now = new Date().toISOString();
        const updated: ApiKeyDocument = {
            ...doc,
            status: 'revoked',
            revokedAt: now,
            updatedAt: now,
        };

        const response = await this.databaseService.upsert(updated);
        updated._rev = response.rev;

        this.logger.log(`API key ${keyId} revoked by admin`);

        return updated;
    }

    async findByHash(keyHash: string): Promise<ApiKeyDocument | null> {
        const result = await this.databaseService.find<ApiKeyDocument>({
            selector: { docType: 'apikey', keyHash },
            use_index: 'apikeys-by-hash',
            limit: 1,
        });

        return result.docs[0] || null;
    }

    updateLastUsed(keyId: string): void {
        const now = new Date().toISOString();

        this.databaseService
            .get<ApiKeyDocument>(keyId)
            .then((doc) => {
                return this.databaseService.upsert({
                    ...doc,
                    lastUsedAt: now,
                    updatedAt: now,
                } as any);
            })
            .catch((err) => {
                this.logger.debug(
                    `Failed to update lastUsedAt for ${keyId}: ${err}`,
                );
            });
    }

    async listKeysByUserId(userId: string): Promise<ApiKeyDocument[]> {
        return this.listKeys(userId);
    }

    private async getKeyDoc(keyId: string): Promise<ApiKeyDocument> {
        try {
            return await this.databaseService.get<ApiKeyDocument>(keyId);
        } catch (err: any) {
            if (err.statusCode === 404) {
                throw new NotFoundException(`API key '${keyId}' not found`);
            }
            throw err;
        }
    }
}
