import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import type { ValidatedKeyMetadata } from './key-validation.types.js';

interface CacheEntry {
    metadata: ValidatedKeyMetadata;
    expiresAt: number;
}

interface WebhookResponse {
    valid: boolean;
    metadata?: ValidatedKeyMetadata;
}

/**
 * Validates API keys by calling an external webhook.
 * If KEY_VALIDATION_WEBHOOK_URL is not set, returns null (standalone mode).
 *
 * Successful validations are cached in-memory keyed by SHA-256 hash of the key.
 * On network error/timeout/5xx, returns null (deny — security-sensitive).
 */
@Injectable()
export class KeyValidationWebhookService {
    private readonly logger = new Logger(KeyValidationWebhookService.name);
    private readonly cache = new Map<string, CacheEntry>();

    private hashKey(raw: string): string {
        return createHash('sha256').update(raw).digest('hex');
    }

    private getCacheTtl(): number {
        return parseInt(
            process.env.KEY_VALIDATION_CACHE_TTL_MS || '60000',
            10,
        );
    }

    private getTimeout(): number {
        return parseInt(
            process.env.KEY_VALIDATION_WEBHOOK_TIMEOUT_MS || '5000',
            10,
        );
    }

    async validateKey(apiKey: string): Promise<ValidatedKeyMetadata | null> {
        const webhookUrl = process.env.KEY_VALIDATION_WEBHOOK_URL;
        if (!webhookUrl) {
            return null;
        }

        const keyHash = this.hashKey(apiKey);

        // Check cache
        const cached = this.cache.get(keyHash);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.metadata;
        }

        // Cache expired — remove stale entry
        if (cached) {
            this.cache.delete(keyHash);
        }

        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey }),
                signal: AbortSignal.timeout(this.getTimeout()),
            });

            if (response.status >= 500) {
                this.logger.warn(
                    `Key validation webhook returned ${response.status} — denying`,
                );
                return null;
            }

            const body: WebhookResponse = await response.json();

            if (!body.valid) {
                return null;
            }

            const metadata: ValidatedKeyMetadata = body.metadata ?? {};

            // Cache the successful validation
            this.cache.set(keyHash, {
                metadata,
                expiresAt: Date.now() + this.getCacheTtl(),
            });

            return metadata;
        } catch (error) {
            this.logger.warn(
                `Key validation webhook failed: ${(error as Error).message} — denying`,
            );
            return null;
        }
    }

    clearCache(): void {
        this.cache.clear();
    }
}
