import type { Hls, HlsJsAdapter, HlsSource } from '@videojs/hlsjs-video';

/*
 * hls.js types are derived from `@videojs/hlsjs-video` rather than imported from `hls.js`: the
 * element nests its own pinned copy, and a workspace can hold a second one hoisted beside it, whose
 * structurally-identical-but-distinct types would not assign.
 */

/** The hls.js instance the element builds. */
export type HlsEngine = InstanceType<typeof Hls>;

/** hls.js's own configuration, as `source.engine.hlsJs` takes it. */
export type HlsJsConfig = NonNullable<NonNullable<HlsSource['engine']>['hlsJs']>;

/** The loader class hls.js is configured with. */
export type LoaderConstructor = HlsEngine['config']['loader'];
type LoaderInstance = InstanceType<LoaderConstructor>;
type LoadArguments = Parameters<LoaderInstance['load']>;
export type LoaderContext = LoadArguments[0];
export type LoaderConfiguration = LoadArguments[1];
export type LoaderCallbacks = LoadArguments[2];

/** The `<hlsjs-video>` element: the adapter's media surface, plus the event target it is. */
export type HlsJsVideoElement = HlsJsAdapter & EventTarget;

/** An hls.js error event's payload, as far as this package reads it. */
export interface HlsErrorData {
    fatal: boolean;
    type: string;
    details: string;
    error?: unknown;
}

/**
 * A media element's own `audioTracks` / `videoTracks` entry — what Chromium exposes for a file played
 * natively when its `AudioVideoTracks` feature is on, and Safari always. Not in TypeScript's DOM lib.
 */
export interface NativeMediaTrack {
    readonly id: string;
    readonly label: string;
    readonly language: string;
    /** Audio tracks: any number may be enabled at once. */
    enabled?: boolean;
    /** Video tracks: exactly one is selected; selecting one deselects the rest. */
    selected?: boolean;
}

/** `AudioTrackList` / `VideoTrackList`: indexable, with `addtrack`, `removetrack` and `change` events. */
export interface NativeMediaTrackList extends EventTarget {
    readonly length: number;
    readonly [index: number]: NativeMediaTrack;
}
