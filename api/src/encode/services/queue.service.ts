import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { SessionService } from './session.service.js';
import { EncodeService } from './encode.service.js';
import { SessionEventsService } from './session-events.service.js';

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
        private readonly sessionEvents: SessionEventsService
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
     * Emits the new queue positions over SSE and triggers drain if idle.
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

        this.notifyQueuePositions();

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
     * Remove a session from the queue before it starts processing.
     * Returns true if the session was found and removed.
     */
    dequeue(sessionId: string): boolean {
        const idx = this.queue.indexOf(sessionId);
        if (idx === -1) return false;

        this.queue.splice(idx, 1);
        this.logger.log(`Session ${sessionId} dequeued`);
        this.notifyQueuePositions();
        return true;
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
     * Emit the current queue position to every session still waiting.
     *
     * SSE is the only push channel left, so a client watching a queued session
     * learns it has moved up from here — polling `getPosition()` is the
     * fallback for clients that are not subscribed.
     */
    private notifyQueuePositions(): void {
        this.queue.forEach((sessionId, idx) => {
            this.sessionEvents.emit({
                sessionId,
                status: 'queued',
                queuePosition: idx + 1,
            });
        });
    }

    get length(): number {
        return this.queue.length;
    }

    get isProcessing(): boolean {
        return this.processing;
    }
}
