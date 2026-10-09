import { onScopeDispose, shallowRef, toValue, watchEffect } from 'vue';
import type { MaybeRefOrGetter, ShallowRef } from 'vue';
import { createInitialState } from '@luminary-media-converter/player-core';
import type { PlayerControllerApi, PlayerState } from '@luminary-media-converter/player-core';

/**
 * Mirrors a controller's state store into a `shallowRef`.
 *
 * Accepts a controller directly, or a ref/getter that produces one later (the
 * player shell can only build its controller once the `<video>` element is
 * mounted). Re-subscribes when the controller changes and unsubscribes when
 * the surrounding effect scope is disposed.
 */
export function usePlayerState(
    controller: MaybeRefOrGetter<PlayerControllerApi | null | undefined>,
): ShallowRef<Readonly<PlayerState>> {
    const state = shallowRef<Readonly<PlayerState>>(createInitialState());

    const stop = watchEffect((onCleanup) => {
        const instance = toValue(controller);
        if (!instance) {
            state.value = createInitialState();
            return;
        }
        state.value = instance.getState();
        const unsubscribe = instance.subscribe((next) => {
            state.value = next;
        });
        onCleanup(unsubscribe);
    });

    onScopeDispose(stop, true);

    return state;
}
