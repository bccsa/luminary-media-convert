/**
 * The video.js construction options, which are the Luminary app's verbatim —
 * this player exists to be visually and behaviourally indistinguishable from
 * it, and the options object is half of that (the other half is `styles.css`).
 *
 * Two deliberate departures from the app's literal object are noted at their
 * lines: the bogus `skipBackwardButton` child, and `IS_ANY_SAFARI` in place of
 * `IS_SAFARI`.
 */
import videojs from 'video.js';
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
    html5: {
        vhs: {
            overrideNative: boolean;
            enableLowInitialPlaylist: boolean;
            maxPlaylistRetries: number;
            useBandwidthFromLocalStorage: boolean;
            useDevicePixelRatio: boolean;
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
        // Subtitles. Unconditional, like the rest of the list, because
        // control-bar children are fixed at construction and a source's text
        // tracks are not known then — video.js hides this button itself while
        // there are none, so Luminary content, which carries no sidecar
        // subtitles today, looks exactly as it did.
        'subsCapsButton',
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
        html5: {
            vhs: {
                // The whole point: VHS drives even where the browser could play
                // HLS natively, because what it is given is a munged blob
                // playlist no native pipeline would resolve.
                overrideNative: true,
                enableLowInitialPlaylist: true,
                maxPlaylistRetries: 10,
                useBandwidthFromLocalStorage: true,
                useDevicePixelRatio: true,
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
