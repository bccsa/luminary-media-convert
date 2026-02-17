import { Injectable, Logger } from '@nestjs/common';
import type { WebhookPayloadDto } from '../dto/webhook-payload.dto.js';

@Injectable()
export class WebhookService {
    private readonly logger = new Logger(WebhookService.name);

    /**
     * POST a status update to the client's webhook URL.
     * Includes the session token as X-Session-Token header for authenticity verification.
     * Failures are logged but never thrown -- webhook errors must not disrupt the encoding pipeline.
     */
    async send(
        webhookUrl: string,
        sessionToken: string,
        payload: WebhookPayloadDto
    ): Promise<void> {
        try {
            const response = await fetch(webhookUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Session-Token': sessionToken,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(10_000),
            });

            if (!response.ok) {
                this.logger.warn(
                    `Webhook returned ${response.status} for session ${payload.sessionId}: ${response.statusText}`
                );
            }
        } catch (err) {
            this.logger.warn(
                `Webhook delivery failed for session ${payload.sessionId}: ${(err as Error).message}`
            );
        }
    }
}
