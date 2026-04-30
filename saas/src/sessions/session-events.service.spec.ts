import { describe, it, expect } from 'vitest';
import { SessionEventsService } from './session-events.service.js';

describe('SessionEventsService', () => {
    it('should emit and receive events via observable', () => {
        const service = new SessionEventsService();
        const received: unknown[] = [];

        const subscription = service.events$.subscribe((event) => received.push(event));

        const event = {
            sessionId: 's1',
            userId: 'u1',
            status: 'encoding',
            progress: 50,
            updatedAt: '2026-01-01T00:00:00.000Z',
        };

        service.emit(event);

        expect(received).toEqual([event]);
        subscription.unsubscribe();
    });

    it('should support multiple subscribers', () => {
        const service = new SessionEventsService();
        const received1: unknown[] = [];
        const received2: unknown[] = [];

        const sub1 = service.events$.subscribe((e) => received1.push(e));
        const sub2 = service.events$.subscribe((e) => received2.push(e));

        const event = {
            sessionId: 's1',
            userId: 'u1',
            status: 'completed',
            updatedAt: '2026-01-01T00:00:00.000Z',
            completedAt: '2026-01-01T00:00:00.000Z',
        };

        service.emit(event);

        expect(received1).toEqual([event]);
        expect(received2).toEqual([event]);

        sub1.unsubscribe();
        sub2.unsubscribe();
    });

    it('should not receive events after unsubscribe', () => {
        const service = new SessionEventsService();
        const received: unknown[] = [];

        const subscription = service.events$.subscribe((e) => received.push(e));
        subscription.unsubscribe();

        service.emit({
            sessionId: 's1',
            userId: 'u1',
            status: 'encoding',
            updatedAt: '2026-01-01T00:00:00.000Z',
        });

        expect(received).toEqual([]);
    });
});
