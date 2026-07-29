import { onUnmounted, watch, type Ref } from 'vue';
import type { TrimSegment } from '../types';
import { planPlaybackJump } from '../utils/trimPlayback';

interface TrimPlaybackDeps {
    /** Ranges that will survive into the encode. */
    ranges: Ref<TrimSegment[]> | Readonly<Ref<TrimSegment[]>>;
    /** Only steer playback while this is true — e.g. before the encode is submitted. */
    active: Readonly<Ref<boolean>>;
    /**
     * Whether the video is actually playing. Steering a paused player would drag
     * the playhead out of any stretch that is not being kept — including a gap the
     * user has parked in deliberately to mark a new clip there.
     */
    isPlaying: Readonly<Ref<boolean>>;
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
    const { ranges, active, isPlaying, getCurrentTime, seek, onPastEnd } = deps;

    let rafId: number | null = null;
    /** Seek already asked for and not yet observed to have landed. */
    let pendingTarget: number | null = null;
    let pendingSince = 0;

    function tick() {
        rafId = requestAnimationFrame(tick);

        if (!active.value || !isPlaying.value || ranges.value.length === 0) {
            // Paused: leave the playhead wherever it has been put.
            pendingTarget = null;
            return;
        }

        const t = getCurrentTime();
        if (!Number.isFinite(t)) return;

        const plan = planPlaybackJump({
            t,
            ranges: ranges.value,
            pendingTarget,
            pendingAgeMs: pendingTarget == null ? 0 : performance.now() - pendingSince,
        });

        if (plan.pendingTarget !== pendingTarget) {
            pendingTarget = plan.pendingTarget;
            pendingSince = performance.now();
        }

        if (plan.seekTo != null) {
            pendingSince = performance.now();
            seek(plan.seekTo);
            return;
        }

        if (plan.pendingTarget == null && ranges.value.every((r) => t >= r.outSec)) {
            onPastEnd?.();
        }
    }

    function start() {
        if (rafId == null) rafId = requestAnimationFrame(tick);
    }

    function stop() {
        if (rafId != null) cancelAnimationFrame(rafId);
        rafId = null;
        pendingTarget = null;
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
