import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockStatfs } = vi.hoisted(() => ({
    mockStatfs: vi.fn(),
}));

vi.mock('fs/promises', () => ({
    statfs: (...args: any[]) => mockStatfs(...args),
}));

import {
    freeBytes,
    ingestShortfall,
    inFlightShortfall,
    reserveBytes,
    DEFAULT_RESERVE_BYTES,
} from './disk-space.js';

const GB = 1024 ** 3;

/** A statfs reading reporting `gb` gigabytes available. */
const withFree = (gb: number) => ({ bavail: (gb * GB) / 4096, bsize: 4096 });

describe('disk-space', () => {
    const originalReserve = process.env.DISK_RESERVE_BYTES;

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.DISK_RESERVE_BYTES;
    });

    afterEach(() => {
        if (originalReserve === undefined)
            delete process.env.DISK_RESERVE_BYTES;
        else process.env.DISK_RESERVE_BYTES = originalReserve;
    });

    describe('freeBytes', () => {
        it('multiplies available blocks by block size', async () => {
            mockStatfs.mockResolvedValueOnce({ bavail: 100, bsize: 4096 });

            await expect(freeBytes('/work')).resolves.toBe(409600);
        });

        it('returns null when the volume cannot be read', async () => {
            mockStatfs.mockRejectedValueOnce(new Error('ENOSYS'));

            await expect(freeBytes('/work')).resolves.toBeNull();
        });
    });

    describe('reserveBytes', () => {
        it('defaults when unset', () => {
            expect(reserveBytes()).toBe(DEFAULT_RESERVE_BYTES);
        });

        it('honours DISK_RESERVE_BYTES', () => {
            process.env.DISK_RESERVE_BYTES = String(5 * GB);

            expect(reserveBytes()).toBe(5 * GB);
        });

        it('falls back to the default on a value that is not a number', () => {
            process.env.DISK_RESERVE_BYTES = 'plenty';

            expect(reserveBytes()).toBe(DEFAULT_RESERVE_BYTES);
        });

        it('allows the reserve to be turned off', () => {
            process.env.DISK_RESERVE_BYTES = '0';

            expect(reserveBytes()).toBe(0);
        });
    });

    describe('ingestShortfall', () => {
        it('refuses a file larger than the free space', async () => {
            mockStatfs.mockResolvedValueOnce(withFree(1));

            await expect(ingestShortfall('/work', 5 * GB)).resolves.toMatch(
                /Not enough disk space/
            );
        });

        it('names both figures so the message can be acted on', async () => {
            mockStatfs.mockResolvedValueOnce(withFree(1));

            const message = await ingestShortfall('/work', 5 * GB);

            expect(message).toContain('5.0 GB');
            expect(message).toContain('1.0 GB');
        });

        it('accepts a file with room to spare', async () => {
            mockStatfs.mockResolvedValueOnce(withFree(100));

            await expect(ingestShortfall('/work', 5 * GB)).resolves.toBeNull();
        });

        it('refuses a file that would fit only by eating the reserve', async () => {
            // 5 GB free, 4 GB file: it fits, but leaves 1 GB behind it — less
            // than a running encode needs to write into.
            mockStatfs.mockResolvedValueOnce(withFree(5));

            await expect(ingestShortfall('/work', 4 * GB)).resolves.toMatch(
                /Not enough disk space/
            );
        });

        it('accepts that same file once the reserve is turned off', async () => {
            process.env.DISK_RESERVE_BYTES = '0';
            mockStatfs.mockResolvedValueOnce(withFree(5));

            await expect(ingestShortfall('/work', 4 * GB)).resolves.toBeNull();
        });

        it('stays silent when the size is unknown', async () => {
            await expect(ingestShortfall('/work', 0)).resolves.toBeNull();
            expect(mockStatfs).not.toHaveBeenCalled();
        });

        it('stays silent when free space cannot be read', async () => {
            mockStatfs.mockRejectedValueOnce(new Error('ENOSYS'));

            await expect(
                ingestShortfall('/work', 500 * GB)
            ).resolves.toBeNull();
        });
    });

    describe('inFlightShortfall', () => {
        it('stops an upload when the volume has fallen into the reserve', async () => {
            // Nothing left of this upload to write, but the disk is nearly gone
            // — something else took it, which is exactly the case to stop for.
            mockStatfs.mockResolvedValueOnce(withFree(1));

            await expect(inFlightShortfall('/work', 0)).resolves.toMatch(
                /Upload stopped/
            );
        });

        it('stops when what is left of the upload no longer fits', async () => {
            mockStatfs.mockResolvedValueOnce(withFree(5));

            await expect(inFlightShortfall('/work', 10 * GB)).resolves.toMatch(
                /Upload stopped/
            );
        });

        it('lets an upload continue when there is room for the rest of it', async () => {
            mockStatfs.mockResolvedValueOnce(withFree(100));

            await expect(
                inFlightShortfall('/work', 10 * GB)
            ).resolves.toBeNull();
        });

        it('judges on the reserve even when the remaining size is unknown', async () => {
            // Unlike the check at creation, an unknown size is not a reason to
            // stay quiet here — the point is to stop the volume reaching empty.
            mockStatfs.mockResolvedValueOnce(withFree(100));

            await expect(inFlightShortfall('/work', 0)).resolves.toBeNull();
            expect(mockStatfs).toHaveBeenCalled();
        });

        it('stays silent when free space cannot be read', async () => {
            mockStatfs.mockRejectedValueOnce(new Error('ENOSYS'));

            await expect(
                inFlightShortfall('/work', 500 * GB)
            ).resolves.toBeNull();
        });
    });
});
