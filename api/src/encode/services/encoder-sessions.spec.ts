import { afterEach, describe, expect, it } from 'vitest';
import {
    acquireEncoderSession,
    acquireEncoderSessions,
    heldEncoderSessions,
    MAX_HARDWARE_SESSIONS,
    resetEncoderSessions,
} from './encoder-sessions';

afterEach(() => resetEncoderSessions());

/** Lets a pending acquire settle without asserting on a timer. */
const settle = () => new Promise((r) => setImmediate(r));

describe('acquireEncoderSession', () => {
    it('hands out up to the cap without waiting', async () => {
        for (let i = 0; i < MAX_HARDWARE_SESSIONS; i++) {
            await acquireEncoderSession();
        }
        expect(heldEncoderSessions()).toBe(MAX_HARDWARE_SESSIONS);
    });

    it('makes the next caller wait until one is released', async () => {
        const releases: Array<() => void> = [];
        for (let i = 0; i < MAX_HARDWARE_SESSIONS; i++) {
            releases.push(await acquireEncoderSession());
        }

        let granted = false;
        const pending = acquireEncoderSession().then((release) => {
            granted = true;
            return release;
        });

        await settle();
        expect(granted).toBe(false);
        expect(heldEncoderSessions()).toBe(MAX_HARDWARE_SESSIONS);

        releases[0]();
        await pending;
        expect(granted).toBe(true);
        expect(heldEncoderSessions()).toBe(MAX_HARDWARE_SESSIONS);
    });

    // The whole point of the module. Three subsystems each staying under the
    // cap on their own is what produced nine sessions on a three-session card.
    it('counts sessions across every caller, not per caller', async () => {
        const ladder = await acquireEncoderSessions(2);
        const preview = await acquireEncoderSession();

        expect(heldEncoderSessions()).toBe(3);

        let extraGranted = false;
        void acquireEncoderSession().then(() => {
            extraGranted = true;
        });
        await settle();
        expect(extraGranted).toBe(false);

        ladder();
        preview();
    });

    // A leaked permit is permanent, and a double release is the other way to
    // corrupt the count — it would let a fourth session open on a three-session
    // card, which is exactly the failure this exists to prevent.
    it('ignores a second release from the same holder', async () => {
        const release = await acquireEncoderSession();
        expect(heldEncoderSessions()).toBe(1);

        release();
        release();
        release();

        expect(heldEncoderSessions()).toBe(0);
    });

    it('wakes waiters in the order they arrived', async () => {
        const releases: Array<() => void> = [];
        for (let i = 0; i < MAX_HARDWARE_SESSIONS; i++) {
            releases.push(await acquireEncoderSession());
        }

        const order: number[] = [];
        const first = acquireEncoderSession().then((r) => {
            order.push(1);
            return r;
        });
        const second = acquireEncoderSession().then((r) => {
            order.push(2);
            return r;
        });

        await settle();
        releases[0]();
        await first;
        releases[1]();
        await second;

        expect(order).toEqual([1, 2]);
    });
});

describe('acquireEncoderSessions', () => {
    it('holds several at once and releases them together', async () => {
        const release = await acquireEncoderSessions(3);
        expect(heldEncoderSessions()).toBe(3);
        release();
        expect(heldEncoderSessions()).toBe(0);
    });

    it('waits for the whole request when the pool is partly held', async () => {
        const one = await acquireEncoderSession();

        let granted = false;
        const wave = acquireEncoderSessions(3).then((r) => {
            granted = true;
            return r;
        });

        await settle();
        // Two of the three are available, so it holds those and waits.
        expect(granted).toBe(false);
        expect(heldEncoderSessions()).toBe(MAX_HARDWARE_SESSIONS);

        one();
        const release = await wave;
        expect(granted).toBe(true);
        release();
        expect(heldEncoderSessions()).toBe(0);
    });

    it('asking for none takes nothing and releases cleanly', async () => {
        const release = await acquireEncoderSessions(0);
        expect(heldEncoderSessions()).toBe(0);
        release();
        expect(heldEncoderSessions()).toBe(0);
    });
});
