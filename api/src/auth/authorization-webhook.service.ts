import {
    Injectable,
    Logger,
    ForbiddenException,
} from '@nestjs/common';
import type { ValidatedKeyMetadata } from './key-validation.types.js';

export interface AuthorizationContext {
    apiKey?: ValidatedKeyMetadata;
    sessionId?: string;
    dto?: unknown;
}

interface AuthorizationResponse {
    allowed: boolean;
    reason?: string;
}

/**
 * Calls an external authorization webhook to verify whether an action
 * should be allowed. Resolution order for the webhook URL:
 * 1. Per-key `authorizationUrl` (from ApiKeyRecord)
 * 2. Global `AUTHORIZATION_WEBHOOK_URL` env var
 * 3. No URL → allow (standalone mode)
 *
 * On 5xx or network error, behaviour depends on `AUTHORIZATION_FAIL_MODE`:
 * - 'closed' (default): deny with ForbiddenException
 * - 'open': allow with a warning
 */
@Injectable()
export class AuthorizationWebhookService {
    private readonly logger = new Logger(AuthorizationWebhookService.name);

    async checkAuthorization(
        action: 'create_session' | 'start_encode',
        context: AuthorizationContext,
    ): Promise<void> {
        const url =
            context.apiKey?.authorizationUrl ||
            process.env.AUTHORIZATION_WEBHOOK_URL;

        if (!url) {
            // Standalone mode — no authorization webhook configured
            return;
        }

        const failMode = process.env.AUTHORIZATION_FAIL_MODE || 'closed';

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action,
                    userId: context.apiKey?.userId,
                    sessionId: context.sessionId,
                    metadata: context.apiKey?.metadata,
                }),
                signal: AbortSignal.timeout(5000),
            });

            if (response.status >= 500) {
                if (failMode === 'closed') {
                    throw new ForbiddenException(
                        'Authorization service unavailable (fail-closed)',
                    );
                }
                this.logger.warn(
                    `Authorization webhook returned ${response.status} — allowing (fail-open)`,
                );
                return;
            }

            const body: AuthorizationResponse = await response.json();

            if (!body.allowed) {
                throw new ForbiddenException(
                    body.reason || 'Authorization denied',
                );
            }
        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw error;
            }

            // Network error or timeout
            if (failMode === 'closed') {
                throw new ForbiddenException(
                    'Authorization service unreachable (fail-closed)',
                );
            }

            this.logger.warn(
                `Authorization webhook failed: ${(error as Error).message} — allowing (fail-open)`,
            );
        }
    }
}
