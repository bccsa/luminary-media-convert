import { computed, onUnmounted, ref, watch, type Ref } from 'vue';

/** Backs off while the source is still being sampled — used when nothing pushes. */
const POLL_MS = [3_000, 5_000, 8_000, 12_000, 20_000];

/**
 * Flat interval used when the caller supplies a `refresh` signal: the push is
 * the driver, and this is only here to catch a stream that quietly stopped.
 */
const PARACHUTE_MS = 20_000;

/** Cheap stand-in for "has the storyboard changed" — cue count only ever grows. */
function countCues(vtt: string): number {
    let count = 0;
    for (const line of vtt.split('\n')) if (line.includes(' --> ')) count++;
    return count;
}

/**
 * Follows a storyboard that is still being generated.
 *
 * The API samples the source in one long ffmpeg pass and serves whatever frames
 * exist so far, so a storyboard fetched early covers only the opening minutes.
 * Asking once — which is all the timeline used to do — left it looking empty or
 * truncated until someone reloaded the page.
 *
 * Push first, poll as a fallback. When `refresh` is supplied the encoder tells
 * us over the session's event stream how many thumbnails it has sampled, and a
 * fetch happens exactly when that number moves; the timer drops to a flat 20s,
 * there only to recover a stream that died without saying so. With no `refresh`
 * there is nothing to react to, so the original backoff does the whole job.
 *
 * Either way it stops when the response says the storyboard is complete, and
 * bumps `version` only when more cues have actually appeared. The version rides
 * on the URL so the timeline, which reads the file itself, refetches only when
 * there is genuinely more to show.
 */
export function useStoryboard(opts: {
    /** Storyboard URL, already carrying its own query string. Null when unavailable. */
    url: Ref<string | null> | Readonly<Ref<string | null>>;
    /** Only worth following before the encode writes its own storyboard. */
    active: Ref<boolean> | Readonly<Ref<boolean>>;
    /**
     * A hint that the storyboard has more to show — derived from the encoder's
     * thumbnail count (and completion flag) off the session event stream.
     * Every change to a non-null value triggers an immediate fetch; the value
     * itself is never interpreted, only compared against its last self.
     */
    refresh?: Ref<unknown> | Readonly<Ref<unknown>>;
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
    /** A fetch is in flight — a push and the safety timer can land together. */
    let polling = false;

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
        // With a push signal the timer stops being how growth is noticed and
        // becomes a parachute, so it stays flat and slow. Without one it is the
        // only mechanism there is, and starts quick before backing off.
        const delay = opts.refresh
            ? PARACHUTE_MS
            : POLL_MS[Math.min(attempts, POLL_MS.length - 1)];
        attempts++;
        timer = setTimeout(() => {
            timer = null;
            void poll();
        }, delay);
    }

    async function poll(): Promise<void> {
        if (disposed || !opts.url.value || !opts.active.value) return;
        // A push and the safety timer can ask at the same moment. The cue-count
        // dedupe makes the second fetch harmless, but harmless is not the same
        // as worth making. Re-arm so the timer chain is not dropped on the way
        // out — the in-flight poll's own schedule() then no-ops.
        if (polling) {
            schedule();
            return;
        }
        polling = true;
        try {
            const response = await doFetch();
            // 404 is the API saying this source, once probed, has no video to
            // sample. This composable is only ever activated for sources the
            // caller already knows have a video track (`sourceStoryboardActive`
            // gates audio files off before a URL exists), so a 404 reaching
            // here is a race — the request landed before ingest finished, or
            // against an encoder that restarted — and is retried like any
            // other transient failure. Latching it as permanent left the
            // timeline frameless for the whole configure phase whenever the
            // first request beat the probe.
            if (response.status === 404) {
                hasFrames.value = false;
                schedule();
                return;
            }
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
        } finally {
            polling = false;
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

    // The push side: the encoder said it has sampled more frames, so go and get
    // them now instead of waiting out the parachute. Not `immediate` — the
    // watch above already made the first request.
    watch(
        () => opts.refresh?.value,
        (signal) => {
            if (signal == null) return;
            if (!opts.url.value || !opts.active.value || complete.value) return;
            void poll();
        }
    );

    onUnmounted(() => {
        disposed = true;
        stop();
    });

    return { versionedUrl, complete, pending, hasFrames, stop };
}
