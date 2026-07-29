import { onUnmounted, watch, type Ref } from 'vue';
import type { TrimSegment } from '../types';
import { nextKeptStart, shouldSeek } from '../utils/trimPlayback';

interface TrimPlaybackDeps {
    /** Ranges that will survive into the encode. */
    ranges: Ref<TrimSegment[]> | Readonly<Ref<TrimSegment[]>>;
    /** Only steer playback while this is true — e.g. before the encode is submitted. */
    active: Readonly<Ref<boolean>>;
    getCurrentTime: () => number;
    seek: (t: number) => void;
    /** Called when playback runs past the last surviving range. */
    onPastEnd?: () => void;
}

/**
 * Keeps preview playback inside the material that will be encoded.
 *
 * Trimming discards everything outside the marked ranges, so a preview that plays
 * straight through those stretches shows something the output will never contain.
 * This watches the play position and jumps over discarded material, which is also
 * what makes a deletion audible and visible rather than only bookkeeping.
 *
 * Polled on animation frames rather than `timeupdate`, which fires roughly four
 * times a second — a quarter of a second of deleted material is very noticeable.
 */
export function useTrimPlayback(deps: TrimPlaybackDeps) {
    const { ranges, active, getCurrentTime, seek, onPastEnd } = deps;

    let rafId: number | null = null;

    function tick() {
        rafId = requestAnimationFrame(tick);

        if (!active.value || ranges.value.length === 0) return;

        const t = getCurrentTime();
        if (!Number.isFinite(t)) return;

        const target = nextKeptStart(t, ranges.value);
        if (target == null) {
            // Either inside kept material, or past the last range with nothing
            // left to play. nextKeptStart cannot tell those apart on its own.
            const beyond = ranges.value.every((r) => t >= r.outSec);
            if (beyond) onPastEnd?.();
            return;
        }

        if (shouldSeek(t, target)) seek(target);
    }

    function start() {
        if (rafId == null) rafId = requestAnimationFrame(tick);
    }

    function stop() {
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
    }

    watch(
        active,
        (on) => {
            if (on) start();
            else stop();
        },
        { immediate: true },
    );

    onUnmounted(stop);

    return { stop };
}
