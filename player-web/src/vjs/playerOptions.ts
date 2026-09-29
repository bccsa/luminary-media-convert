/**
 * The video.js construction options, which are the Luminary app's verbatim —
 * this player exists to be visually and behaviourally indistinguishable from
 * it, and the options object is half of that (the other half is `styles.css`).
 *
 * Three deliberate departures from the app's literal object are noted at their
 * lines: the bogus `skipBackwardButton` child, `IS_ANY_SAFARI` in place of
 * `IS_SAFARI`, and `cacheEncryptionKeys`, which changes nothing a viewer sees.
 */
import videojs from 'video.js';
import type Player from 'video.js/dist/types/player';
import type { PlayerControlsOptions } from '../controls';

/**
 * Only the options this module actually sets.
 *
 * video.js types its own options as `any`, so nothing here is checked by it;
 * naming the shape is what lets a test read `controlBar.children` off the
 * result without casting, and what documents the contract to the next reader.
 */
export interface VideoJsOptions {
    fluid: boolean;
    /** Techs video.js may choose between, in order of preference. */
    techOrder: string[];
    html5: {
        vhs: {
            overrideNative: boolean;
            experimentalUseMMS: boolean;
            enableLowInitialPlaylist: boolean;
            maxPlaylistRetries: number;
            useBandwidthFromLocalStorage: boolean;
            useDevicePixelRatio: boolean;
            cacheEncryptionKeys: boolean;
        };
        nativeAudioTracks: boolean;
        nativeVideoTracks: boolean;
    };
    autoplay: boolean;
    preload: string;
    enableSmoothSeeking: boolean;
    playbackRates: number[];
    controlBar: {
        children: string[];
        skipButtons: { forward?: number; backward?: number };
    };
}

/**
 * The intervals video.js ships skip-button icons for.
 *
 * A `SkipForward` whose configured interval is not one of these hides itself
 * outright (video.js 8 `control-bar/skip-buttons/skip-forward.js`), so an
 * unsnapped 15 does not render a "15" button — it renders nothing at all.
 */
export const SKIP_ICON_SECONDS = [5, 10, 30] as const;

/**
 * Rounds a requested skip interval onto the set video.js can draw.
 *
 * Snapping rather than refusing, because the alternative is a control that
 * silently disappears; snapping ships a button whose label and jump agree, at
 * the nearest interval the engine can render. `0` (and anything not finite or
 * negative) means "no button", which is honest and is why it survives as
 * `undefined` rather than a default.
 */
export function snapSkipSeconds(seconds: number): number | undefined {
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    let closest: number = SKIP_ICON_SECONDS[0];
    for (const candidate of SKIP_ICON_SECONDS) {
        if (Math.abs(candidate - seconds) < Math.abs(closest - seconds)) {
            closest = candidate;
        }
    }
    return closest;
}

/** The tech `videojs-youtube` registers, as `techOrder` names it. */
export const YOUTUBE_TECH = 'youtube';

/**
 * Puts the YouTube tech first in this player's order, ahead of a YouTube
 * source. Call it once the tech has been loaded; a second call changes nothing.
 *
 * It has to be listed: `videojs-youtube` registers its tech but does not add
 * itself to the order, and video.js only considers what is listed — so without
 * this a YouTube source finds no tech that accepts `video/youtube`, falls
 * through to Html5, and a YouTube page URL ends up as the src of a bare
 * <video>. The browser renders its broken-media placeholder and the iframe API
 * fills the console with postMessage origin warnings.
 *
 * First, and harmless there for the rest of the player's life: the Youtube tech
 * only claims `video/youtube`, so every HLS source still goes to Html5.
 *
 * Called whether or not the load succeeded. If it did not, video.js logs that
 * the tech is undefined — which is then exactly what went wrong.
 *
 * A new array rather than an edit in place: the one in the options may be
 * video.js's shared default in a player this module did not configure.
 */
export function preferYouTubeTech(player: Player): void {
    const order: string[] = player.options_.techOrder;
    if (order[0] === YOUTUBE_TECH) return;
    player.options_.techOrder = [
        YOUTUBE_TECH,
        ...order.filter((name) => name !== YOUTUBE_TECH),
    ];
}

/**
 * Builds the options for one player instance.
 *
 * The control-bar children are listed rather than defaulted because this skin
 * positions every one of them absolutely — the order in this array is the DOM
 * order the CSS is written against, and the default order puts controls where
 * no rule expects them.
 *
 * `pictureInPictureToggle` stays in the list even for YouTube playback, where
 * it does nothing: control-bar children are fixed at construction, and the
 * player can switch between YouTube and LMC sources over its lifetime. It is
 * hidden by the `.vjs-youtube` CSS rules instead, exactly as the Luminary app
 * does it.
 */
export function buildVideoJsOptions(controls: PlayerControlsOptions): VideoJsOptions {
    const forward = snapSkipSeconds(controls.skipForwardSeconds);
    const backward = snapSkipSeconds(controls.skipBackSeconds);

    const children: string[] = [
        // A host with its own language selector beside the player can drop this
        // one; every other child is structural to the skin.
        ...(controls.audioMenu ? ['audioTrackButton'] : []),
        'playToggle',
        'progressControl',
        'liveDisplay',
        'fullscreenToggle',
        'pictureInPictureToggle',
        // Subtitles. video.js hides this itself while a source has no text
        // tracks, so leaving it in costs nothing visually — but an app that has
        // never had the control can drop it outright rather than have one appear
        // the first time a stream ships captions.
        ...(controls.subtitlesMenu ? ['subsCapsButton'] : []),
        'playbackRateMenuButton',
        'volumePanel',
        // The app's list also carries `skipBackwardButton`, which is not a
        // registered component name and therefore renders nothing. Not carried
        // across: `skipForward`/`skipBackward` are the working pair, and they
        // are already here.
        ...(forward ? ['skipForward'] : []),
        ...(backward ? ['skipBackward'] : []),
    ];

    return {
        fluid: false,
        // Html5 alone to begin with. The YouTube tech is loaded on demand, and
        // listing a tech that is not registered yet costs a console error —
        // "The "youtube" tech is undefined" — every time video.js picks a tech,
        // which in a session that never plays YouTube is every HLS load. It
        // reads as a failure and is not one. `preferYouTubeTech` adds it at the
        // point it is registered.
        techOrder: ['html5'],
        html5: {
            vhs: {
                // The whole point: VHS drives even where the browser could play
                // HLS natively, because what it is given is a munged blob
                // playlist no native pipeline would resolve.
                overrideNative: true,
                // iPhones have ManagedMediaSource but no MediaSource; without this VHS
                // refuses every source there.
                experimentalUseMMS: true,
                enableLowInitialPlaylist: true,
                maxPlaylistRetries: 10,
                useBandwidthFromLocalStorage: true,
                useDevicePixelRatio: true,
                // Not in the app's object. Without it VHS asks for the key
                // before every encrypted segment; the in-memory interceptor
                // answers each time, so nothing reaches the network either
                // way, but every ask is a fake request, a key copy and a
                // microtask. The cache belongs to one segment loader, and every
                // src() builds new loaders, so a source never inherits the key
                // of the one before it under the shared `luminary://key` URI.
                cacheEncryptionKeys: true,
            },
            // The app tests `IS_SAFARI`, which is false on iPhone/iPad, where
            // the native track lists are the ones that actually work.
            // `IS_ANY_SAFARI` covers desktop and iOS alike.
            nativeAudioTracks: videojs.browser.IS_ANY_SAFARI,
            nativeVideoTracks: videojs.browser.IS_ANY_SAFARI,
        },
        // Autoplay is the host's decision, made by calling play() after a
        // gesture — a library that autoplays cannot be talked out of it.
        autoplay: false,
        preload: 'auto',
        enableSmoothSeeking: true,
        playbackRates: [0.5, 0.7, 1, 1.5],
        controlBar: {
            children,
            skipButtons: {
                ...(forward ? { forward } : {}),
                ...(backward ? { backward } : {}),
            },
        },
    };
}
