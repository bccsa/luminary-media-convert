import { ref, type Ref } from 'vue';
import type { Segment } from '../components/segment-editor';

/**
 * Tracks trim ranges removed from the timeline so they can be brought back.
 *
 * Deleting a range on the timeline is not final: it drops out of what will be
 * encoded, but stays listed beside the player until the encode is submitted, at
 * which point the trim markers are consumed and the list is meaningless.
 *
 * Restoring puts the range back at its original position — the list is keyed by
 * where a range was, not by the order it happened to be deleted in.
 */
export function useTrimDeletions(segments: Ref<Segment[]>) {
    const removed = ref<Segment[]>([]);

    /** Record a range that has just left the timeline. */
    function record(segment: Segment): void {
        if (removed.value.some((s) => s.id === segment.id)) return;
        removed.value = [...removed.value, { ...segment }].sort(
            (a, b) => a.inSec - b.inSec,
        );
    }

    /** Put a removed range back where it came from. */
    function restore(id: string): void {
        const entry = removed.value.find((s) => s.id === id);
        if (!entry) return;
        removed.value = removed.value.filter((s) => s.id !== id);
        if (segments.value.some((s) => s.id === id)) return;
        segments.value = [...segments.value, { ...entry }].sort(
            (a, b) => a.inSec - b.inSec,
        );
    }

    function restoreAll(): void {
        for (const entry of [...removed.value]) restore(entry.id);
    }

    /** Forget everything — the ranges have been consumed by an encode. */
    function clear(): void {
        removed.value = [];
    }

    return { removed, record, restore, restoreAll, clear };
}
