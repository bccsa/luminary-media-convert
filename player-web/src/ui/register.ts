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

/** A globe, the shape the fullscreen audio screen already uses for language: a person-and-bubble reads as chat. */
const GLOBE_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>';

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
    globe: GLOBE_ICON,
    speed: speedIcon,
    switches: switchesIcon,
    'volume-high': volumeHighIcon,
    'volume-low': volumeLowIcon,
    'volume-off': volumeOffIcon,
});
