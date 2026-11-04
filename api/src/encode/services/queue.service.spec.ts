import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATIC_TRY_DELAYS_MS, QueueService } from './queue.service.js';
import type { SessionService } from './session.service.js';
import type { EncodeService } from './encode.service.js';
import type { SessionEventsService } from './session-events.service.js';

const updateStatus = vi.fn();
const setFailed = vi.fn();
const processSession = vi.fn<(id: string) => Promise<void>>();
const emit = vi.fn();
const prepareDelivery = vi.fn();
const get = vi.fn();
const appendToError = vi.fn();

const sessions = {
    updateStatus,
    setFailed,
    get,
    appendToError,
} as unknown as SessionService;
const encoder = {
    processSession,
    prepareDelivery,
} as unknown as EncodeService;
const events = { emit } as unknown as SessionEventsService;

const onFinished = vi.fn();

function build(): QueueService {
    return new QueueService(sessions, encoder, events, onFinished);
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
    prepareDelivery.mockReset();
    processSession.mockReset().mockResolvedValue(undefined);
    get.mockReset().mockReturnValue({ status: 'completed' });
    appendToError.mockReset();
    onFinished.mockReset();
});

describe('QueueService — enqueueing', () => {
    it('settles the playback URL and key before the session starts waiting', async () => {
        const job = deferred();
        processSession.mockReturnValue(job.promise);
        const queue = build();

        queue.enqueue('a');

        expect(prepareDelivery).toHaveBeenCalledWith('a');
        expect(prepareDelivery.mock.invocationCallOrder[0]).toBeLessThan(
            updateStatus.mock.invocationCallOrder[0]
        );

        job.release();
        await settle();
    });

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

describe('QueueService — trying again after a lost connection', () => {
    const lostConnection = { status: 'failed', networkFailure: true };

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('puts the encode back in the queue after a pause, and says so', async () => {
        get.mockReturnValue(lostConnection);
        const queue = build();

        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(0);
        expect(processSession).toHaveBeenCalledTimes(1);
        expect(appendToError).toHaveBeenCalledWith(
            'a',
            expect.stringMatching(
                /Trying again by itself in 30 s \(attempt 1 of 3\)/
            )
        );

        await vi.advanceTimersByTimeAsync(AUTOMATIC_TRY_DELAYS_MS[0]);
        expect(processSession).toHaveBeenCalledTimes(2);
    });

    it('gives up after its tries, waiting longer before each', async () => {
        get.mockReturnValue(lostConnection);
        const queue = build();

        queue.enqueue('a');
        for (const delay of AUTOMATIC_TRY_DELAYS_MS) {
            await vi.advanceTimersByTimeAsync(delay);
        }
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

        expect(processSession).toHaveBeenCalledTimes(
            1 + AUTOMATIC_TRY_DELAYS_MS.length
        );
    });

    it('does not try again after a failure that was not the connection', async () => {
        get.mockReturnValue({ status: 'failed' });
        const queue = build();

        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(AUTOMATIC_TRY_DELAYS_MS[0] * 2);

        expect(processSession).toHaveBeenCalledTimes(1);
        expect(appendToError).not.toHaveBeenCalled();
    });

    it('leaves alone an encode someone continued or deleted meanwhile', async () => {
        get.mockReturnValueOnce(lostConnection).mockReturnValue({
            status: 'encoding',
        });
        const queue = build();

        queue.enqueue('a');
        await vi.advanceTimersByTimeAsync(AUTOMATIC_TRY_DELAYS_MS[0]);

        expect(processSession).toHaveBeenCalledTimes(1);
    });
});

describe('QueueService — telling the host how an encode ended', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('reports a finished encode with its post title', async () => {
        get.mockReturnValue({
            status: 'completed',
            title: 'Sunday meeting',
            filePath: '/media/sunday.mp4',
        });
        build().enqueue('a');
        await vi.advanceTimersByTimeAsync(0);

        expect(onFinished).toHaveBeenCalledExactlyOnceWith({
            sessionId: 'a',
            outcome: 'completed',
            title: 'Sunday meeting',
            fileName: 'sunday.mp4',
            message: undefined,
        });
    });

    it('reports a failure with the sentence the session shows', async () => {
        get.mockReturnValue({
            status: 'failed',
            error: 'The encoder ran out of disk space.',
        });
        build().enqueue('a');
        await vi.advanceTimersByTimeAsync(0);

        expect(onFinished).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                outcome: 'failed',
                message: 'The encoder ran out of disk space.',
            })
        );
    });

    it('waits for the automatic tries before reporting a lost connection', async () => {
        get.mockReturnValue({ status: 'failed', networkFailure: true });
        build().enqueue('a');
        await vi.advanceTimersByTimeAsync(0);
        expect(onFinished).not.toHaveBeenCalled();

        for (const delay of AUTOMATIC_TRY_DELAYS_MS) {
            await vi.advanceTimersByTimeAsync(delay);
        }
        expect(onFinished).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ outcome: 'failed' })
        );
    });

    it('reports nothing for an encode stopped by hand', async () => {
        get.mockReturnValue({ status: 'failed', stopped: true });
        build().enqueue('a');
        await vi.advanceTimersByTimeAsync(0);

        expect(onFinished).not.toHaveBeenCalled();
    });

    it('reports nothing for an encode cancelled meanwhile', async () => {
        get.mockReturnValue(undefined);
        build().enqueue('a');
        await vi.advanceTimersByTimeAsync(0);

        expect(onFinished).not.toHaveBeenCalled();
    });

    it('carries on when the host throws', async () => {
        onFinished.mockImplementation(() => {
            throw new Error('no notification centre');
        });
        const queue = build();
        queue.enqueue('a');
        queue.enqueue('b');
        await vi.advanceTimersByTimeAsync(0);

        expect(processSession).toHaveBeenCalledTimes(2);
    });
});
