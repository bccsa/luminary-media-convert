/** `make-sample-stream.py`'s key: bundled with the stream it opens, so it protects nothing. */
export const SAMPLE_KEY = '6c756d696e6172792d737069a4e2c0de';

/** `scripts/live-stream.sh`'s key, answered from memory as `luminary://key`. */
export const LIVE_KEY = '6c756d696e6172792d6c697665a4e2c0';

export const DEFAULT_YOUTUBE = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

export interface LabSource {
    id: string;
    label: string;
    masterUrl: string;
    keyHex?: string;
}

/**
 * Where the dev server is. A browser has it as its own origin; an app loaded from its bundle
 * (`https://localhost`) needs `VITE_LAB_ORIGIN` (this machine's LAN address), or live reload.
 */
export function labOrigin(): string {
    return (import.meta.env.VITE_LAB_ORIGIN as string | undefined) || window.location.origin;
}

/**
 * Where an encode's scrub frames would be: `thumbnails/thumbnails.vtt` beside the master. Offered for
 * every stream, as a host that knows its encodes do; a stream without them has no file there, and
 * the player shows no roster.
 */
export function thumbnailSidecar(masterUrl: string): { thumbnails: { url: string } } | undefined {
    const path = masterUrl.split(/[?#]/)[0] ?? masterUrl;
    const slash = path.lastIndexOf('/');
    return slash < 0 ? undefined : { thumbnails: { url: `${path.slice(0, slash)}/thumbnails/thumbnails.vtt` } };
}

export function presets(): LabSource[] {
    return [
        {
            id: 'sample',
            label: 'Sample · encrypted byte-range, 2 angles, 4 languages',
            masterUrl: `${labOrigin()}/sample/master.m3u8`,
            keyHex: SAMPLE_KEY,
        },
        {
            id: 'live',
            label: 'Live · AES-128, from scripts/live-stream.sh',
            masterUrl: `${labOrigin()}/live/master.m3u8`,
            keyHex: LIVE_KEY,
        },
        {
            id: 'bipbop',
            label: 'Apple bipbop · fMP4, many languages',
            masterUrl: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
        },
        {
            id: 'angel-one',
            label: 'Angel One · 5 audio languages, 4 subtitles (Shaka demo)',
            masterUrl: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8',
        },
        { id: 'custom', label: 'Custom URL', masterUrl: '' },
    ];
}
