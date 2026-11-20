import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { CMS_ACK_WAIT_MS, CmsAckService } from './cms-ack.service.js';

const R1 = 'https://cdn/master_r1.m3u8';
const R2 = 'https://cdn/master_r2.m3u8';

/** A CMS session whose current version is `hlsUrl`, stored up to `ackedHlsUrl`. */
function setup(session: Record<string, unknown> = {}) {
    const state: Record<string, unknown> = {
        id: 's1',
        readToken: 'read_x',
        hlsUrl: R2,
        ackedHlsUrl: R1,
        ...session,
    };
    const sessionService = {
        get: vi.fn((id: string) => (id === 's1' ? state : undefined)),
        setAckedHlsUrl: vi.fn((_id: string, url: string) => {
            state.ackedHlsUrl = url;
        }),
    };
    const service = new CmsAckService(sessionService as never);
    return { service, state };
}

/** Whether the promise has settled, without waiting for it. */
async function settled(p: Promise<unknown>): Promise<boolean> {
    let done = false;
    p.then(
        () => (done = true),
        () => (done = true)
    );
    await Promise.resolve();
    await Promise.resolve();
    return done;
}

describe('CmsAckService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    describe('assertReady', () => {
        it('lets a session with no CMS behind it through', async () => {
            const { service } = setup({ readToken: undefined });
            await expect(service.assertReady('s1')).resolves.toBeUndefined();
        });

        it('refuses at once when no CMS page follows the session', async () => {
            const { service } = setup({ ackedHlsUrl: R2 });
            await expect(service.assertReady('s1')).rejects.toMatchObject({
                response: { code: 'CMS_NOT_ACKNOWLEDGED' },
            });
        });

        it('passes at once when the page follows and the current version is stored', async () => {
            const { service } = setup({ ackedHlsUrl: R2 });
            service.opened('s1');
            await expect(service.assertReady('s1')).resolves.toBeUndefined();
        });

        it('waits for the ack of a save just made', async () => {
            const { service } = setup();
            service.opened('s1');
            const ready = service.assertReady('s1');
            expect(await settled(ready)).toBe(false);
            service.ack('s1', R2);
            await expect(ready).resolves.toBeUndefined();
        });

        it('gives up early when the page goes', async () => {
            const { service } = setup();
            service.opened('s1');
            const ready = service.assertReady('s1');
            service.closed('s1');
            await expect(ready).rejects.toBeInstanceOf(ConflictException);
        });

        it('refuses after the wait when the ack never comes', async () => {
            const { service } = setup();
            service.opened('s1');
            const ready = service.assertReady('s1');
            const refused =
                expect(ready).rejects.toBeInstanceOf(ConflictException);
            await vi.advanceTimersByTimeAsync(CMS_ACK_WAIT_MS);
            await refused;
        });
    });

    describe('awaitAck', () => {
        it('is undefined for a session with no CMS behind it', async () => {
            const { service } = setup({ readToken: undefined });
            await expect(service.awaitAck('s1', R2)).resolves.toBeUndefined();
        });

        it('is true once the CMS stores the version', async () => {
            const { service } = setup();
            service.opened('s1');
            const acked = service.awaitAck('s1', R2);
            service.ack('s1', R2);
            await expect(acked).resolves.toBe(true);
        });

        it('ignores an ack for an older version', async () => {
            const { service, state } = setup();
            service.opened('s1');
            const acked = service.awaitAck('s1', R2);
            service.ack('s1', R1);
            expect(state.ackedHlsUrl).toBe(R1);
            expect(await settled(acked)).toBe(false);
            await vi.advanceTimersByTimeAsync(CMS_ACK_WAIT_MS);
            await expect(acked).resolves.toBe(false);
        });

        it('gives up early, unacked, when the page goes mid-save', async () => {
            const { service } = setup();
            service.opened('s1');
            const acked = service.awaitAck('s1', R2);
            service.closed('s1');
            await expect(acked).resolves.toBe(false);
        });

        it('keeps waiting while another page still follows', async () => {
            const { service } = setup();
            service.opened('s1');
            service.opened('s1');
            const acked = service.awaitAck('s1', R2);
            service.closed('s1');
            expect(await settled(acked)).toBe(false);
            service.ack('s1', R2);
            await expect(acked).resolves.toBe(true);
        });

        it('is false after the wait when the ack never comes', async () => {
            const { service } = setup();
            service.opened('s1');
            const acked = service.awaitAck('s1', R2);
            await vi.advanceTimersByTimeAsync(CMS_ACK_WAIT_MS);
            await expect(acked).resolves.toBe(false);
        });
    });
});
