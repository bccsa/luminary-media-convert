import { ref, watch, onScopeDispose, type Ref } from 'vue';
import { isEncryptedPayload } from '@luminary-media-converter/hls';
import { decryptLmcenc } from '@luminary-media-converter/player-core';
import {
    absolutizeStoryboardVtt,
    retimeStoryboardVtt,
} from '../utils/storyboardVtt';
import type { TrimSegment } from '../types';

/**
 * The storyboard URL to give the timeline: decrypted where it has to be, and
 * re-timed onto the trimmed programme where it has to be.
 *
 * Two things can stand between the file in the bucket and a filmstrip.
 *
 * Encryption: a session that encrypts its output encrypts every text asset with
 * it, storyboard included, so the object at that address is LMCENC and the
 * editor — which fetches the URL itself — would be handed ciphertext.
 *
 * Trimming: the encoder samples its storyboard from the source, so its cues are
 * in source time. Once ranges are trimmed the timeline shows the retained
 * ranges laid end to end, and the frames no longer line up — cut material stays
 * on the strip, which reads as though the encode were ignoring the trim.
 * Re-timing has to happen here rather than in the editor: the editor is shared
 * and deliberately knows nothing about trimming, and the app already owns the
 * source ↔ output mapping.
 *
 * Either correction means serving the result as a blob, which is why sprite
 * references are made absolute on the way through. When neither applies the
 * original URL is passed straight back — there is nothing to correct and no
 * reason to spend a fetch.
 */
export function useStoryboardVttUrl(opts: {
    url: Ref<string | null | undefined>;
    ranges: Ref<TrimSegment[]>;
    /** The session key, when this session has one. */
    keyHex: Ref<string | undefined>;
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
        [opts.url, opts.ranges, opts.keyHex],
        async ([source, ranges, keyHex], _prev, onCleanup) => {
            let cancelled = false;
            onCleanup(() => {
                cancelled = true;
            });

            if (!source) {
                release();
                url.value = null;
                return;
            }
            // Nothing to decrypt and nothing to re-time: the file at its own
            // address is already what the editor wants.
            if (!ranges.length && !keyHex) {
                release();
                url.value = source;
                return;
            }

            try {
                const res = await fetch(source);
                if (!res.ok || cancelled) return;

                const bytes = new Uint8Array(await res.arrayBuffer());
                // A key does not mean this particular file is encrypted — the
                // source storyboard is served by the local encoder in the
                // clear, and playlist encryption is opt-outable.
                const text = new TextDecoder().decode(
                    keyHex && isEncryptedPayload(bytes)
                        ? await decryptLmcenc(bytes, keyHex)
                        : bytes
                );
                if (cancelled) return;

                const prepared = ranges.length
                    ? retimeStoryboardVtt(text, source, ranges)
                    : absolutizeStoryboardVtt(text, source);

                release();
                objectUrl = URL.createObjectURL(
                    new Blob([prepared], { type: 'text/vtt' })
                );
                url.value = objectUrl;
            } catch {
                // A storyboard that cannot be read or re-timed is left off the
                // timeline rather than shown at the wrong offsets.
            }
        },
        { immediate: true, deep: true }
    );

    onScopeDispose(release);

    return { url };
}
