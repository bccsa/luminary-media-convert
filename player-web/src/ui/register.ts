/**
 * Registers the Video.js 10 elements and icons the controls use, and nothing else.
 *
 * The obvious import, `@videojs/html/video/skin`, registers every element Video.js has, all its icons and the
 * packaged skin with its own template and stylesheet — about 550 kB (120 kB gzipped) added to an app, almost
 * none of it drawn here. Each element below is a module of its own, so an app's bundler takes only these.
 *
 * Every tag `controlsHtml.ts` and `LuminaryPlayer.vue` write must be named here: an unregistered one is just an
 * inert tag, which is how the skip buttons once came to do nothing. A test walks the live page for exactly that.
 */
import '@videojs/html/video/player';
import '@videojs/html/media/hlsjs-video';

import '@videojs/html/ui/container';
import '@videojs/html/ui/controls';
import '@videojs/html/ui/controls-backdrop';
import '@videojs/html/ui/controls-content';
import '@videojs/html/ui/gesture';

import '@videojs/html/ui/play-button';
import '@videojs/html/ui/seek-button';
import '@videojs/html/ui/mute-button';
import '@videojs/html/ui/fullscreen-button';
import '@videojs/html/ui/pip-button';
import '@videojs/html/ui/cast-button';
import '@videojs/html/ui/airplay-button';

import '@videojs/html/ui/time';
import '@videojs/html/ui/time-slider';
import '@videojs/html/ui/volume-slider';
import '@videojs/html/ui/volume-popover';
import '@videojs/html/ui/slider-track';
import '@videojs/html/ui/slider-fill';
import '@videojs/html/ui/slider-buffer';
import '@videojs/html/ui/slider-preview';
import '@videojs/html/ui/slider-value';

import '@videojs/html/ui/menu';
import '@videojs/html/ui/menu-content';
import '@videojs/html/ui/menu-radio-item';
import '@videojs/html/ui/menu-item-indicator';
import '@videojs/html/ui/quality-radio-group';
import '@videojs/html/ui/audio-track-radio-group';
import '@videojs/html/ui/playback-rate-radio-group';
import '@videojs/html/ui/captions-radio-group';

import {
    airPlayEnterIcon,
    airPlayExitIcon,
    captionsOffIcon,
    checkIcon,
    castEnterIcon,
    castExitIcon,
    fullscreenEnterIcon,
    fullscreenExitIcon,
    pauseIcon,
    pipEnterIcon,
    pipExitIcon,
    playIcon,
    registerIcons,
    restartIcon,
    speedIcon,
    switchesIcon,
    volumeHighIcon,
    volumeLowIcon,
    volumeOffIcon,
} from '@videojs/html/icons';

/** The Heroicons "language" glyph, which the rest of Luminary uses for choosing a language. */
const LANGUAGE_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.5 21 5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 0 1 6-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 0 1-3.827-5.802"/></svg>';

/** The icon names `controlsHtml.ts` writes as `<media-icon name="…">`. */
registerIcons('default', {
    'airplay-enter': airPlayEnterIcon,
    'airplay-exit': airPlayExitIcon,
    'captions-off': captionsOffIcon,
    check: checkIcon,
    'cast-enter': castEnterIcon,
    'cast-exit': castExitIcon,
    'fullscreen-enter': fullscreenEnterIcon,
    'fullscreen-exit': fullscreenExitIcon,
    pause: pauseIcon,
    'pip-enter': pipEnterIcon,
    'pip-exit': pipExitIcon,
    play: playIcon,
    restart: restartIcon,
    language: LANGUAGE_ICON,
    speed: speedIcon,
    switches: switchesIcon,
    'volume-high': volumeHighIcon,
    'volume-low': volumeLowIcon,
    'volume-off': volumeOffIcon,
});
