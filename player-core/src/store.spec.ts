import { describe, expect, it, vi } from 'vitest';
import { StateStore, createInitialState } from './store.js';

describe('StateStore', () => {
    it('starts idle and hands out frozen snapshots', () => {
        const store = new StateStore();
        const state = store.getState();
        expect(state.lifecycle).toBe('idle');
        expect(Object.isFrozen(state)).toBe(true);
        expect(() => {
            (state as { playing: boolean }).playing = true;
        }).toThrow();
    });

    it('replaces the snapshot rather than mutating it', () => {
        const store = new StateStore();
        const before = store.getState();
        store.setState({ currentTime: 12 });
        expect(store.getState()).not.toBe(before);
        expect(before.currentTime).toBe(0);
        expect(store.getState().currentTime).toBe(12);
    });

    it('notifies subscribers on change only', () => {
        const store = new StateStore();
        const listener = vi.fn();
        store.subscribe(listener);

        store.setState({ playing: true });
        expect(listener).toHaveBeenCalledTimes(1);

        store.setState({ playing: true });
        expect(listener).toHaveBeenCalledTimes(1);

        store.setState({ playing: false });
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('unsubscribes cleanly', () => {
        const store = new StateStore();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        unsubscribe();
        store.setState({ ended: true });
        expect(listener).not.toHaveBeenCalled();
    });

    it('always notifies on reset()', () => {
        const store = new StateStore();
        const listener = vi.fn();
        store.subscribe(listener);
        store.reset(createInitialState());
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
