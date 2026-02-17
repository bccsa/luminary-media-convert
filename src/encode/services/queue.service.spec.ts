import { QueueService } from './queue.service.js';
import { SessionService } from './session.service.js';
import { EncodeService } from './encode.service.js';
import { WebhookService } from './webhook.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

function makeConfig(): CreateSessionDto {
    return {
        type: 'video',
        renditions: [
            { width: 1280, height: 720, videoBitrateKbps: 2500, audioBitrateKbps: 128 },
        ],
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
        webhook: {
            url: 'https://example.com/webhook',
            sessionToken: 'tok',
        },
    };
}

describe('QueueService', () => {
    let queueService: QueueService;
    let sessionService: SessionService;
    let encodeService: jest.Mocked<EncodeService>;
    let webhookService: jest.Mocked<WebhookService>;

    beforeEach(() => {
        sessionService = new SessionService();

        encodeService = {
            processSession: jest.fn().mockResolvedValue(undefined),
        } as any;

        webhookService = {
            send: jest.fn().mockResolvedValue(undefined),
        } as any;

        queueService = new QueueService(
            sessionService,
            encodeService,
            webhookService
        );
    });

    describe('enqueue', () => {
        it('should add session to queue and return position', () => {
            const session = sessionService.create(makeConfig());
            const position = queueService.enqueue(session.id);

            expect(position).toBe(1);
        });

        it('should return incrementing positions for items behind the first', () => {
            // drain() synchronously shifts the first item and awaits processSession.
            // So the first enqueue returns 1, but the item is immediately shifted for processing.
            // Subsequent enqueues pile up behind the in-flight job.
            encodeService.processSession.mockReturnValue(
                new Promise(() => {}) // never resolves, keeps first item processing
            );

            const s1 = sessionService.create(makeConfig());
            const s2 = sessionService.create(makeConfig());
            const s3 = sessionService.create(makeConfig());

            const p1 = queueService.enqueue(s1.id);
            // s1 is now being processed (shifted off queue). Queue has 0 items.
            expect(p1).toBe(1);

            const p2 = queueService.enqueue(s2.id);
            expect(p2).toBe(1); // first in the waiting queue

            const p3 = queueService.enqueue(s3.id);
            expect(p3).toBe(2); // second in the waiting queue
        });

        it('should update session status to queued', () => {
            const session = sessionService.create(makeConfig());
            queueService.enqueue(session.id);

            expect(sessionService.get(session.id)!.status).toBe('queued');
        });

        it('should send a queued webhook', () => {
            const session = sessionService.create(makeConfig());
            queueService.enqueue(session.id);

            expect(webhookService.send).toHaveBeenCalledWith(
                'https://example.com/webhook',
                'tok',
                expect.objectContaining({
                    sessionId: session.id,
                    status: 'queued',
                    queuePosition: 1,
                })
            );
        });

        it('should return -1 when shutting down', async () => {
            await queueService.onModuleDestroy();
            const session = sessionService.create(makeConfig());
            const pos = queueService.enqueue(session.id);

            expect(pos).toBe(-1);
        });
    });

    describe('getPosition', () => {
        it('should return 1-based position', () => {
            encodeService.processSession.mockReturnValue(
                new Promise(() => {})
            );

            const s1 = sessionService.create(makeConfig());
            const s2 = sessionService.create(makeConfig());

            queueService.enqueue(s1.id);
            queueService.enqueue(s2.id);

            // s1 is being processed (shifted from queue), s2 is at position 1
            expect(queueService.getPosition(s2.id)).toBe(1);
        });

        it('should return null for unknown session', () => {
            expect(queueService.getPosition('nonexistent')).toBeNull();
        });
    });

    describe('drain', () => {
        it('should process sessions in FIFO order', async () => {
            const order: string[] = [];
            encodeService.processSession.mockImplementation(
                async (id: string) => {
                    order.push(id);
                }
            );

            const s1 = sessionService.create(makeConfig());
            const s2 = sessionService.create(makeConfig());
            const s3 = sessionService.create(makeConfig());

            queueService.enqueue(s1.id);
            queueService.enqueue(s2.id);
            queueService.enqueue(s3.id);

            // Wait for drain to complete
            await new Promise((r) => setTimeout(r, 50));

            expect(order).toEqual([s1.id, s2.id, s3.id]);
        });

        it('should continue processing after a job failure', async () => {
            const processed: string[] = [];

            encodeService.processSession.mockImplementation(
                async (id: string) => {
                    if (processed.length === 0) {
                        processed.push(id);
                        throw new Error('Simulated failure');
                    }
                    processed.push(id);
                }
            );

            const s1 = sessionService.create(makeConfig());
            const s2 = sessionService.create(makeConfig());

            queueService.enqueue(s1.id);
            queueService.enqueue(s2.id);

            await new Promise((r) => setTimeout(r, 50));

            expect(processed).toEqual([s1.id, s2.id]);
            expect(sessionService.get(s1.id)!.status).toBe('failed');
        });

        it('should set processing to false when queue is empty', async () => {
            const session = sessionService.create(makeConfig());
            queueService.enqueue(session.id);

            await new Promise((r) => setTimeout(r, 50));

            expect(queueService.isProcessing).toBe(false);
            expect(queueService.length).toBe(0);
        });
    });

    describe('onModuleDestroy', () => {
        it('should prevent new enqueues after shutdown', async () => {
            await queueService.onModuleDestroy();

            const session = sessionService.create(makeConfig());
            expect(queueService.enqueue(session.id)).toBe(-1);
        });
    });
});
