/**
 * Framework-free state store.
 *
 * Snapshots are immutable and replaced wholesale, so any UI layer can treat
 * identity as the change signal (`shallowRef` in Vue, `useSyncExternalStore` in
 * React, a plain `subscribe` elsewhere) without the wrapper knowing about any
 * of them.
 */

import type { PlayerState, Unsubscribe } from './types.js';

export function createInitialState(): PlayerState {
    return {
        lifecycle: 'idle',
        playing: false,
        ended: false,
        stalled: false,
        currentTime: 0,
        duration: 0,
        bufferedEnd: 0,
        playbackRate: 1,

        angles: [],
        activeAngleId: null,

        qualities: [],
        activeQualityId: 'auto',

        audioTracks: [],
        activeAudioTrackId: null,

        subtitleTracks: [],
        activeSubtitleTrackId: null,

        chapterTracks: [],
        activeChapterTrackId: null,
        chapters: [],

        isAudioOnly: false,
        error: null,
    };
}

export class StateStore {
    private state: Readonly<PlayerState>;
    private readonly listeners = new Set<
        (state: Readonly<PlayerState>) => void
    >();

    constructor(initial: PlayerState = createInitialState()) {
        this.state = Object.freeze(initial);
    }

    getState(): Readonly<PlayerState> {
        return this.state;
    }

    /** Merge a patch. No-ops (and does not notify) when nothing changes. */
    setState(patch: Partial<PlayerState>): void {
        let changed = false;
        for (const key of Object.keys(patch) as (keyof PlayerState)[]) {
            if (patch[key] !== this.state[key]) {
                changed = true;
                break;
            }
        }
        if (!changed) return;

        this.state = Object.freeze({ ...this.state, ...patch });
        for (const listener of [...this.listeners]) listener(this.state);
    }

    /** Replace the whole snapshot (a new load). Always notifies. */
    reset(state: PlayerState): void {
        this.state = Object.freeze(state);
        for (const listener of [...this.listeners]) listener(this.state);
    }

    subscribe(listener: (state: Readonly<PlayerState>) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    clearListeners(): void {
        this.listeners.clear();
    }
}
