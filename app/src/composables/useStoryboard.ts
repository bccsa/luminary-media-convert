import { computed, onUnmounted, ref, watch, type Ref } from 'vue';

/** Backs off while the source is still being sampled. */
const POLL_MS = [3_000, 5_000, 8_000, 12_000, 20_000];

/** Cheap stand-in for "has the storyboard changed" — cue count only ever grows. */
function countCues(vtt: string): number {
    let count = 0;
    for (const line of vtt.split('\n')) if (line.includes(' --> ')) count++;
    return count;
}

/**
 * Follows a storyboard that is still being generated.
 *
 * The API samples the source in one long ffmpeg pass and serves whatever sprites
 * exist so far, so a storyboard fetched early covers only the opening minutes.
 * Asking once — which is all the timeline used to do — left it looking empty or
 * truncated until someone reloaded the page.
 *
 * Polls until the response says it is complete, bumping `version` whenever more
 * cues have appeared. The version rides on the URL so the timeline, which reads
 * the file itself, refetches only when there is genuinely more to show.
 */
export function useStoryboard(opts: {
    /** Storyboard URL, already carrying its own query string. Null when unavailable. */
    url: Ref<string | null> | Readonly<Ref<string | null>>;
    /** Only worth following before the encode writes its own storyboard. */
    active: Ref<boolean> | Readonly<Ref<boolean>>;
    fetcher?: typeof fetch;
}) {
    const complete = ref(false);
    const version = ref(0);
    /** True once at least one cue exists — before that the timeline has nothing. */
    const hasFrames = ref(false);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let lastCues = -1;
    let disposed = false;

    const doFetch = () => (opts.fetcher ?? fetch)(opts.url.value as string, {
        cache: 'no-store',
    });

    /** Versioned so a partial storyboard is never mistaken for the finished one. */
    const versionedUrl = computed(() => {
        const url = opts.url.value;
        if (!url) return null;
        return version.value === 0 ? url : `${url}&v=${version.value}`;
    });

    /** The timeline is waiting on frames that are still being made. */
    const pending = computed(
        () => Boolean(opts.active.value) && !complete.value && !!opts.url.value
    );

    function stop() {
        if (timer) clearTimeout(timer);
        timer = null;
    }

    function schedule() {
        if (disposed || timer || complete.value || !opts.active.value) return;
        const delay = POLL_MS[Math.min(attempts, POLL_MS.length - 1)];
        attempts++;
        timer = setTimeout(() => {
            timer = null;
            void poll();
        }, delay);
    }

    async function poll(): Promise<void> {
        if (disposed || !opts.url.value || !opts.active.value) return;
        try {
            const response = await doFetch();
            if (response.ok) {
                const done =
                    response.headers.get('X-Storyboard-Complete') === 'true';
                const cues = countCues(await response.text());
                if (cues !== lastCues) {
                    lastCues = cues;
                    hasFrames.value = cues > 0;
                    // Only move the URL when there is more to draw; a fresh
                    // version with identical content is a pointless refetch.
                    version.value++;
                }
                if (done) {
                    complete.value = true;
                    stop();
                    return;
                }
            }
        } catch {
            // Storyboards are an enhancement; keep trying quietly.
        }
        schedule();
    }

    watch(
        () => [opts.url.value, opts.active.value] as const,
        ([url, active]) => {
            stop();
            if (!url || !active) return;
            complete.value = false;
            attempts = 0;
            void poll();
        },
        { immediate: true }
    );

    onUnmounted(() => {
        disposed = true;
        stop();
    });

    return { versionedUrl, complete, pending, hasFrames, stop };
}
