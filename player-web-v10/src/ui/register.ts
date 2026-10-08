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
    speechIcon,
    speedIcon,
    switchesIcon,
    volumeHighIcon,
    volumeLowIcon,
    volumeOffIcon,
} from '@videojs/html/icons';

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
    speech: speechIcon,
    speed: speedIcon,
    switches: switchesIcon,
    'volume-high': volumeHighIcon,
    'volume-low': volumeLowIcon,
    'volume-off': volumeOffIcon,
});
