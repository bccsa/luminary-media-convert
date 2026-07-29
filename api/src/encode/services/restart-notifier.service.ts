import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { SessionService } from './session.service.js';
import { WebhookService } from './webhook.service.js';

/**
 * Tells the outside world about sessions a restart killed.
 *
 * `SessionService.restore` marks anything that was mid-encode as failed, since
 * the queue and the FFmpeg process died with the old process. That correction
 * used to stay inside the encoder: no webhook was ever sent, so the SaaS record
 * kept saying `encoding` indefinitely, the session list kept showing it as
 * running, and opening it started a poller against a session the API would
 * eventually forget — the 401 wall of #68, guaranteed from the next day onward
 * once the scheduled sweep removed the failed session.
 *
 * Runs on bootstrap rather than during `onModuleInit`: restore happens there, and
 * an outbound call has no place in module initialisation, where a slow or
 * unreachable receiver would hold up startup.
 */
@Injectable()
export class RestartNotifierService implements OnApplicationBootstrap {
    private readonly logger = new Logger(RestartNotifierService.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly webhookService: WebhookService
    ) {}

    onApplicationBootstrap(): void {
        // Deliberately not awaited: startup does not depend on the receiver
        // being reachable, and `notify` swallows its own failures.
        void this.notify();
    }

    /** Exposed for tests; `onApplicationBootstrap` is the only production caller. */
    async notify(): Promise<number> {
        const failures = this.sessionService.takeRestartFailures();
        if (failures.length === 0) return 0;

        let sent = 0;
        for (const session of failures) {
            const webhook = session.config?.webhook;
            if (!webhook) continue;

            try {
                await this.webhookService.send(
                    webhook.url,
                    webhook.sessionToken,
                    {
                        sessionId: session.id,
                        status: 'failed',
                        error: session.error,
                        message: 'Encoding failed',
                    }
                );
                sent++;
            } catch (err) {
                // A session left reading `encoding` forever is bad, but not a
                // reason to abandon the rest or to fail startup.
                this.logger.warn(
                    `Could not report restart failure for session ${session.id}: ${(err as Error).message}`
                );
            }
        }

        if (sent > 0) {
            this.logger.log(
                `Reported ${sent} session(s) failed by the restart`
            );
        }
        return sent;
    }
}
