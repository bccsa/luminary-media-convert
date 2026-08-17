import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueService } from './queue.service.js';
import type { SessionService } from './session.service.js';
import type { EncodeService } from './encode.service.js';
import type { SessionEventsService } from './session-events.service.js';

const updateStatus = vi.fn();
const setFailed = vi.fn();
const processSession = vi.fn<(id: string) => Promise<void>>();
const emit = vi.fn();

const sessions = { updateStatus, setFailed } as unknown as SessionService;
const encoder = { processSession } as unknown as EncodeService;
const events = { emit } as unknown as SessionEventsService;

function build(): QueueService {
    return new QueueService(sessions, encoder, events);
}

/** A job that only resolves when told to, so the queue can be observed mid-run. */
function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

/** Let the drain loop advance past its pending awaits. */
const settle = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
    updateStatus.mockReset();
    setFailed.mockReset();
    emit.mockReset();
    processSession.mockReset().mockResolvedValue(undefined);
});

describe('QueueService — enqueueing', () => {
    it('marks the session queued and returns its position', async () => {
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        expect(queue.enqueue('a')).toBe(1);
        expect(updateStatus).toHaveBeenCalledWith('a', 'queued');

        job.release();
        await settle();
    });

    it('numbers the queue by who is still waiting, not by arrival', async () => {
        // Draining starts synchronously and shifts the running session off the
        // queue before enqueue() returns for the next one — so the first caller
        // gets 1 meaning "running", and the one after it gets 1 meaning "next".
        // Position is a place in the line ahead, which is what a client waiting
        // on it wants to know.
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        expect(queue.enqueue('a')).toBe(1);
        expect(queue.enqueue('b')).toBe(1);
        expect(queue.enqueue('c')).toBe(2);

        job.release();
        await settle();
    });

    it('runs one encode at a time', async () => {
        const first = deferred();
        processSession
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue(undefined);
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');
        await settle();

        // 'b' waits: the queue is not a fan-out, and two ffmpeg runs would
        // contend for the same CPU and disk.
        expect(processSession).toHaveBeenCalledTimes(1);
        expect(processSession).toHaveBeenCalledWith('a');

        first.release();
        await settle();
        expect(processSession).toHaveBeenCalledWith('b');
    });

    it('processes in FIFO order', async () => {
        const order: string[] = [];
        processSession.mockImplementation(async (id) => {
            order.push(id);
        });
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');
        queue.enqueue('c');
        await settle();
        await settle();

        expect(order).toEqual(['a', 'b', 'c']);
    });
});

describe('QueueService — positions', () => {
    it('reports the position of a waiting session', async () => {
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');
        await settle();

        // 'a' has been shifted off to be processed; 'b' is now first in line.
        expect(queue.getPosition('b')).toBe(1);

        job.release();
        await settle();
    });

    it('reports null for a session it is not holding', () => {
        expect(build().getPosition('nope')).toBeNull();
    });

    it('tells every waiting session where it now stands', async () => {
        // SSE is the only push channel, so a client watching a queued session
        // learns it has moved up from here.
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');
        emit.mockClear();
        queue.enqueue('c');

        expect(emit).toHaveBeenCalledWith({
            sessionId: 'b',
            status: 'queued',
            queuePosition: 1,
        });
        expect(emit).toHaveBeenCalledWith({
            sessionId: 'c',
            status: 'queued',
            queuePosition: 2,
        });

        job.release();
        await settle();
    });
});

describe('QueueService — dequeueing', () => {
    it('removes a session that has not started yet', async () => {
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');

        expect(queue.dequeue('b')).toBe(true);
        expect(queue.getPosition('b')).toBeNull();

        job.release();
        await settle();
    });

    it('reports false for a session it does not hold', () => {
        expect(build().dequeue('nope')).toBe(false);
    });

    it('closes the gap for everyone behind it', async () => {
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');
        queue.enqueue('c');
        emit.mockClear();

        queue.dequeue('b');

        expect(emit).toHaveBeenCalledWith(
            expect.objectContaining({ sessionId: 'c', queuePosition: 1 })
        );

        job.release();
        await settle();
    });
});

describe('QueueService — failures', () => {
    it('carries on after a job throws', async () => {
        // processSession is supposed to swallow its own errors; if one escapes,
        // it must not take the rest of the queue down with it.
        processSession
            .mockRejectedValueOnce(new Error('ffmpeg exploded'))
            .mockResolvedValue(undefined);
        const queue = build();

        queue.enqueue('a');
        queue.enqueue('b');
        await settle();
        await settle();

        expect(setFailed).toHaveBeenCalledWith('a', 'ffmpeg exploded');
        expect(processSession).toHaveBeenCalledWith('b');
    });

    it('names a reason even when the error carries none', async () => {
        processSession.mockRejectedValueOnce(new Error(''));
        const queue = build();

        queue.enqueue('a');
        await settle();
        await settle();

        expect(setFailed).toHaveBeenCalledWith('a', 'Unexpected queue error');
    });
});

describe('QueueService — shutdown', () => {
    it('waits for the running encode before letting the process quit', async () => {
        // Quitting out from under ffmpeg leaves an orphan process and half an
        // output in the bucket.
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();
        queue.enqueue('a');
        await settle();

        let done = false;
        const shutdown = queue.onModuleDestroy().then(() => {
            done = true;
        });

        await settle();
        expect(done).toBe(false);

        job.release();
        await shutdown;
        expect(done).toBe(true);
    });

    it('refuses new work once shutting down', async () => {
        const queue = build();
        await queue.onModuleDestroy();

        expect(queue.enqueue('a')).toBe(-1);
        expect(updateStatus).not.toHaveBeenCalled();
    });

    it('stops draining rather than starting the next job', async () => {
        const first = deferred();
        processSession
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue(undefined);
        const queue = build();
        queue.enqueue('a');
        queue.enqueue('b');
        await settle();

        const shutdown = queue.onModuleDestroy();
        first.release();
        await shutdown;

        // 'b' is left queued for the next boot rather than started during
        // shutdown, where it could not finish.
        expect(processSession).toHaveBeenCalledTimes(1);
    });
});
