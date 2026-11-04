import {
    Inject,
    Injectable,
    Logger,
    OnModuleDestroy,
    Optional,
} from '@nestjs/common';
import { basename } from 'path';
import { SessionService } from './session.service.js';
import { EncodeService } from './encode.service.js';
import { SessionEventsService } from './session-events.service.js';
import {
    ENCODE_OUTCOME_HOOK,
    type EncodeOutcomeHook,
} from '../encode-outcome-hook.js';

/** How long to wait before each automatic try after a lost connection. */
export const AUTOMATIC_TRY_DELAYS_MS = [30_000, 120_000, 300_000];

const formatDelay = (ms: number) =>
    ms < 60_000 ? `${ms / 1000} s` : `${ms / 60_000} min`;

@Injectable()
export class QueueService implements OnModuleDestroy {
    private readonly logger = new Logger(QueueService.name);
    private readonly queue: string[] = [];
    private processing = false;
    private shuttingDown = false;
    private drainPromise: Promise<void> | null = null;
    /** Automatic tries made so far, per session that keeps losing its connection. */
    private readonly automaticTries = new Map<string, number>();

    constructor(
        private readonly sessionService: SessionService,
        private readonly encodeService: EncodeService,
        private readonly sessionEvents: SessionEventsService,
        @Optional()
        @Inject(ENCODE_OUTCOME_HOOK)
        private readonly onFinished?: EncodeOutcomeHook
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

        this.encodeService.prepareDelivery(sessionId);
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
     * Stop the encode running for a session, keeping it to continue later.
     * @returns whether it was encoding
     */
    stop(sessionId: string): boolean {
        return this.encodeService.stop(sessionId);
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
                    this.tryAgainIfConnectionLost(sessionId);
                    this.reportOutcome(sessionId);
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
                    this.reportOutcome(sessionId);
                }
            }
        } finally {
            this.processing = false;
            this.drainPromise = null;
        }
    }

    /**
     * After an encode lost its connection to storage, put it back in the queue
     * after a pause, a few times, longer each time: the connection usually
     * comes back, and the next run continues from what is already in storage.
     * Anything else that happens to the session in the meantime (a continue by
     * hand, a delete) wins, because the try only runs if it is still failed.
     */
    private tryAgainIfConnectionLost(sessionId: string): void {
        const session = this.sessionService.get(sessionId);
        if (session?.status !== 'failed' || !session.networkFailure) {
            this.automaticTries.delete(sessionId);
            return;
        }
        const tries = this.automaticTries.get(sessionId) ?? 0;
        if (tries >= AUTOMATIC_TRY_DELAYS_MS.length) {
            this.automaticTries.delete(sessionId);
            return;
        }
        this.automaticTries.set(sessionId, tries + 1);
        const delay = AUTOMATIC_TRY_DELAYS_MS[tries]!;
        this.sessionService.appendToError(
            sessionId,
            `Trying again by itself in ${formatDelay(delay)} (attempt ${tries + 1} of ${AUTOMATIC_TRY_DELAYS_MS.length}).`
        );
        this.logger.log(
            `Session ${sessionId} lost its connection to storage; trying again in ${delay / 1000}s`
        );
        setTimeout(() => {
            if (this.shuttingDown) return;
            if (this.sessionService.get(sessionId)?.status !== 'failed') return;
            this.enqueue(sessionId);
        }, delay).unref?.();
    }

    /**
     * Tell the host how an encode ended, once that is final: done, or failed
     * with no automatic try still to come. A session deleted meanwhile (a
     * cancel) or stopped by hand has nothing to report.
     */
    private reportOutcome(sessionId: string): void {
        if (!this.onFinished || this.shuttingDown) return;
        const session = this.sessionService.get(sessionId);
        if (!session) return;
        // A stop is what the person asked for; telling them is noise.
        if (session.status === 'failed' && session.stopped) return;
        const failedForGood =
            session.status === 'failed' && !this.automaticTries.has(sessionId);
        if (session.status !== 'completed' && !failedForGood) return;
        try {
            this.onFinished({
                sessionId,
                outcome:
                    session.status === 'completed' ? 'completed' : 'failed',
                title: session.title,
                fileName: session.filePath
                    ? basename(session.filePath)
                    : undefined,
                message: failedForGood ? session.error : undefined,
            });
        } catch (err) {
            this.logger.warn(
                `Reporting how session ${sessionId} ended failed: ${(err as Error).message}`
            );
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
