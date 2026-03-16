import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, randomUUID, createHash } from 'crypto';
import type { CreateApiKeyDto } from './dto/create-key.dto.js';

export interface ApiKeyRecord {
    id: string;
    keyHash: string;
    keyPrefix: string;
    name: string;
    webhookUrl?: string;
    authorizationUrl?: string;
    metadata?: Record<string, unknown>;
    scopes: string[];
    expiresAt?: Date;
    lastUsedAt?: Date;
    createdAt: Date;
    revokedAt?: Date;
}

@Injectable()
export class ApiKeyService {
    private readonly logger = new Logger(ApiKeyService.name);

    /** Primary lookup: SHA-256 hash → record */
    private readonly byHash = new Map<string, ApiKeyRecord>();

    /** Secondary lookup: id → record */
    private readonly byId = new Map<string, ApiKeyRecord>();

    private hashKey(raw: string): string {
        return createHash('sha256').update(raw).digest('hex');
    }

    create(dto: CreateApiKeyDto): { key: string; record: ApiKeyRecord } {
        const raw = `lmc_${randomBytes(32).toString('hex')}`;
        const keyHash = this.hashKey(raw);
        const id = randomUUID();

        const record: ApiKeyRecord = {
            id,
            keyHash,
            keyPrefix: raw.slice(0, 12),
            name: dto.name,
            webhookUrl: dto.webhookUrl,
            authorizationUrl: dto.authorizationUrl,
            metadata: dto.metadata,
            scopes: [],
            expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
            createdAt: new Date(),
        };

        this.byHash.set(keyHash, record);
        this.byId.set(id, record);

        this.logger.log(`API key created: ${id} (${dto.name})`);
        return { key: raw, record };
    }

    validateKey(rawKey: string): ApiKeyRecord | null {
        const hash = this.hashKey(rawKey);
        const record = this.byHash.get(hash);
        if (!record) return null;
        if (record.revokedAt) return null;
        if (record.expiresAt && record.expiresAt.getTime() < Date.now()) return null;

        record.lastUsedAt = new Date();
        return record;
    }

    findAll(): ApiKeyRecord[] {
        return [...this.byId.values()].filter((r) => !r.revokedAt);
    }

    findById(id: string): ApiKeyRecord | undefined {
        return this.byId.get(id);
    }

    revoke(id: string): boolean {
        const record = this.byId.get(id);
        if (!record || record.revokedAt) return false;

        record.revokedAt = new Date();
        this.byHash.delete(record.keyHash);
        this.logger.log(`API key revoked: ${id}`);
        return true;
    }
}
