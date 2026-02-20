import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SessionService } from './session.service.js';
import { EncodeService } from './encode.service.js';
import { WebhookService } from './webhook.service.js';

@Injectable()
export class QueueService implements OnModuleDestroy {
    private readonly logger = new Logger(QueueService.name);
    private readonly queue: string[] = [];
    private processing = false;
    private shuttingDown = false;
    private drainPromise: Promise<void> | null = null;

    constructor(
        private readonly sessionService: SessionService,
        private readonly encodeService: EncodeService,
        private readonly webhookService: WebhookService
    ) {}

    async onModuleDestroy(): Promise<void> {
        this.logger.log('Shutting down: stopping queue...');
        this.shuttingDown = true;
        if (this.drainPromise) {
            await this.drainPromise;
        }
    }

    /**
     * Add a session to the encoding queue.
     * Sends a "queued" webhook and triggers drain if idle.
     */
    enqueue(sessionId: string): number {
        if (this.shuttingDown) {
            this.logger.warn(
                `Rejecting enqueue for ${sessionId}: service is shutting down`
            );
            return -1;
        }

        this.queue.push(sessionId);
        const position = this.queue.length;

        this.sessionService.updateStatus(sessionId, 'queued');
        this.logger.log(
            `Session ${sessionId} enqueued at position ${position}`
        );

        // Send webhook asynchronously
        const session = this.sessionService.get(sessionId);
        if (session?.config.webhook) {
            this.webhookService
                .send(
                    session.config.webhook.url,
                    session.config.webhook.sessionToken,
                    {
                        sessionId,
                        status: 'queued',
                        queuePosition: position,
                        message: `Queued at position ${position}`,
                    }
                )
                .catch(() => {});
        }

        // Trigger drain if not already processing
        if (!this.processing) {
            this.drainPromise = this.drain();
        }

        return position;
    }

    /**
     * Get the 1-based queue position for a session.
     * Returns null if the session is not in the queue.
     */
    getPosition(sessionId: string): number | null {
        const idx = this.queue.indexOf(sessionId);
        if (idx === -1) return null;
        return idx + 1;
    }

    /**
     * Drain the queue: process one job at a time in FIFO order.
     * Never throws -- individual job failures are caught and the queue continues.
     */
    private async drain(): Promise<void> {
        if (this.processing) return;
        this.processing = true;

        try {
            while (this.queue.length > 0 && !this.shuttingDown) {
                const sessionId = this.queue.shift()!;

                // Notify remaining queued sessions of their updated positions
                this.notifyQueuePositions();

                this.logger.log(
                    `Processing session ${sessionId} (${this.queue.length} remaining in queue)`
                );

                try {
                    await this.encodeService.processSession(sessionId);
                } catch (err) {
                    // This should not happen since encodeService.processSession
                    // catches all errors internally, but guard against it anyway
                    this.logger.error(
                        `Unexpected error processing session ${sessionId}: ${(err as Error).message}`
                    );
                    this.sessionService.setFailed(
                        sessionId,
                        (err as Error).message || 'Unexpected queue error'
                    );
                }
            }
        } finally {
            this.processing = false;
            this.drainPromise = null;
        }
    }

    /**
     * Send updated queue position webhooks to all sessions still waiting in the queue.
     */
    private notifyQueuePositions(): void {
        this.queue.forEach((sessionId, idx) => {
            const session = this.sessionService.get(sessionId);
            if (session?.config.webhook) {
                this.webhookService
                    .send(
                        session.config.webhook.url,
                        session.config.webhook.sessionToken,
                        {
                            sessionId,
                            status: 'queued',
                            queuePosition: idx + 1,
                            message: `Queue position updated to ${idx + 1}`,
                        }
                    )
                    .catch(() => {});
            }
        });
    }

    get length(): number {
        return this.queue.length;
    }

    get isProcessing(): boolean {
        return this.processing;
    }
}
