/** `make-sample-stream.py`'s key: bundled with the stream it opens, so it protects nothing. */
export const SAMPLE_KEY = '6c756d696e6172792d737069a4e2c0de';

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

export function presets(): LabSource[] {
    return [
        {
            id: 'sample',
            label: 'Sample · encrypted byte-range, 2 angles, 4 languages',
            masterUrl: `${labOrigin()}/sample/master.m3u8`,
            keyHex: SAMPLE_KEY,
        },
        {
            id: 'bipbop',
            label: 'Apple bipbop · fMP4, many languages',
            masterUrl: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
        },
        { id: 'custom', label: 'Custom URL', masterUrl: '' },
    ];
}
