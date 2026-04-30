import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'dns/promises';
import type { WebhookPayloadDto } from '../dto/webhook-payload.dto.js';

// Block only the cloud metadata endpoint — the high-value SSRF target.
// We don't block all private IPs because webhook URLs are provided by
// authenticated users (API key or SaaS session), and legitimate services
// may run on private networks, behind VPNs, or on localhost.
const BLOCKED_HOSTNAME_PATTERNS = [
    /^169\.254\./,          // Link-local / cloud metadata (AWS, GCP, Azure)
    /^\[fe80:/i,            // IPv6 link-local
];

function isBlockedHostname(hostname: string): boolean {
    return BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(hostname));
}

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
            const parsed = new URL(webhookUrl);

            // Block cloud metadata endpoints (SSRF protection)
            if (isBlockedHostname(parsed.hostname)) {
                this.logger.warn(
                    `Webhook blocked for session ${payload.sessionId}: cloud metadata URL ${parsed.hostname}`,
                );
                return;
            }

            // DNS-resolve and check the resolved IP too
            try {
                const { address } = await lookup(parsed.hostname);
                if (isBlockedHostname(address)) {
                    this.logger.warn(
                        `Webhook blocked for session ${payload.sessionId}: ${parsed.hostname} resolves to cloud metadata IP ${address}`,
                    );
                    return;
                }
            } catch {
                // DNS failure — allow the fetch to fail naturally with a
                // network error rather than silently dropping the webhook
            }

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
