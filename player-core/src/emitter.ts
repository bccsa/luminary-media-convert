/**
 * Tiny typed event emitter shared by the controller (and available to adapters).
 * Kept separate from the state store: state is a snapshot you read, events are
 * moments you react to.
 */

import type { Unsubscribe } from './types.js';

export class Emitter<Events> {
    private readonly listeners = new Map<
        keyof Events,
        Set<(payload: never) => void>
    >();

    on<E extends keyof Events>(
        event: E,
        listener: (payload: Events[E]) => void,
    ): Unsubscribe {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        const entry = listener as (payload: never) => void;
        set.add(entry);
        return () => {
            set?.delete(entry);
        };
    }

    emit<E extends keyof Events>(event: E, payload: Events[E]): void {
        const set = this.listeners.get(event);
        if (!set) return;
        for (const listener of [...set]) {
            (listener as (payload: Events[E]) => void)(payload);
        }
    }

    clear(): void {
        this.listeners.clear();
    }
}
