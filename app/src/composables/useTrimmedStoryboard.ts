import { ref, watch, onScopeDispose, type Ref } from 'vue';
import { retimeStoryboardVtt } from '../utils/storyboardVtt';
import type { TrimSegment } from '../types';

/**
 * The storyboard URL to give the timeline, re-timed onto the trimmed programme.
 *
 * The encoder samples its storyboard from the source, so its cues are in source
 * time. Once ranges are trimmed the timeline shows the retained ranges laid end
 * to end, and the frames no longer line up — cut material stays on the strip,
 * which reads as though the encode were ignoring the trim.
 *
 * Re-timing has to happen here rather than in the editor: the editor is shared
 * and deliberately knows nothing about trimming, and the app already owns the
 * source ↔ output mapping. The rewritten cues are handed over as a blob URL,
 * which is also why sprite references are made absolute on the way through.
 *
 * With no ranges the original URL is passed straight back — the untrimmed
 * timeline is already in source time, so there is nothing to correct and no
 * reason to spend a fetch.
 */
export function useTrimmedStoryboard(opts: {
    url: Ref<string | null | undefined>;
    ranges: Ref<TrimSegment[]>;
}) {
    const url = ref<string | null>(null);
    let objectUrl: string | null = null;

    function release() {
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        }
    }

    watch(
        [opts.url, opts.ranges],
        async ([source, ranges], _prev, onCleanup) => {
            let cancelled = false;
            onCleanup(() => {
                cancelled = true;
            });

            if (!source) {
                release();
                url.value = null;
                return;
            }
            if (!ranges.length) {
                release();
                url.value = source;
                return;
            }

            try {
                const res = await fetch(source);
                if (!res.ok || cancelled) return;
                const retimed = retimeStoryboardVtt(
                    await res.text(),
                    source,
                    ranges
                );
                if (cancelled) return;
                release();
                objectUrl = URL.createObjectURL(
                    new Blob([retimed], { type: 'text/vtt' })
                );
                url.value = objectUrl;
            } catch {
                // A storyboard that cannot be re-timed is left off the timeline
                // rather than shown at the wrong offsets.
            }
        },
        { immediate: true, deep: true }
    );

    onScopeDispose(release);

    return { url };
}
