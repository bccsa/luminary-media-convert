/**
 * Every string `NativeLuminaryPlayer` renders: the ones `player-web`'s `PlayerMessages` has for
 * the same surfaces, with the same defaults and the same names, so a host passes one `messages`
 * object to either player. Native full-screen draws its own labels (plan 05).
 */

import type { PlayerError } from '@luminary-media-converter/player-core';
import type { FullscreenTexts } from '../bridge.js';

export interface NativePlayerMessages {
    /** Shown while the master playlist has not been published yet. */
    comingSoon: string;
    /** Fallback for any error code without a dedicated message. */
    errorGeneric: string;
    errorUnsupportedBrowser: string;
    errorKeyRequired: string;
    errorNetwork: string;
    errorMedia: string;
    retry: string;
    play: string;
    /** The audio / video toggle's video half. */
    videoModeLabel: string;
    /** Its audio half: sound only, no video data downloaded. */
    audioModeLabel: string;
    // What native full-screen says. The names are `player-web`'s where it has the same string.
    pause: string;
    scrubberLabel: string;
    /** `{seconds}` is the interval. */
    skipBack: string;
    skipForward: string;
    exitFullscreen: string;
    audioMenuLabel: string;
    subtitlesMenuLabel: string;
    subtitlesOff: string;
    pictureInPicture: string;
    playbackRate: string;
    mute: string;
    unmute: string;
    loading: string;
}

export const DEFAULT_NATIVE_MESSAGES: NativePlayerMessages = {
    comingSoon: 'Coming soon',
    errorGeneric: 'This video could not be played.',
    errorUnsupportedBrowser: 'This browser cannot play this video. Please update it or try another one.',
    errorKeyRequired: 'This video is protected and no key was supplied.',
    errorNetwork: 'The video could not be reached. Check your connection.',
    errorMedia: 'Playback of this video failed.',
    retry: 'Try again',
    play: 'Play',
    videoModeLabel: 'Play video',
    audioModeLabel: 'Play audio only',
    pause: 'Pause',
    scrubberLabel: 'Seek',
    skipBack: 'Skip back {seconds} seconds',
    skipForward: 'Skip forward {seconds} seconds',
    exitFullscreen: 'Exit full screen',
    audioMenuLabel: 'Audio',
    subtitlesMenuLabel: 'Subtitles',
    subtitlesOff: 'Off',
    pictureInPicture: 'Picture-in-Picture',
    playbackRate: 'Playback Rate',
    mute: 'Mute',
    unmute: 'Unmute',
    loading: 'Loading',
};

/** What native full-screen is told to say, from the messages the host gave. */
export function fullscreenTexts(messages: NativePlayerMessages): FullscreenTexts {
    return {
        play: messages.play,
        pause: messages.pause,
        seek: messages.scrubberLabel,
        skipBack: messages.skipBack,
        skipForward: messages.skipForward,
        exitFullscreen: messages.exitFullscreen,
        audioMenu: messages.audioMenuLabel,
        subtitlesMenu: messages.subtitlesMenuLabel,
        subtitlesOff: messages.subtitlesOff,
        pictureInPicture: messages.pictureInPicture,
        playbackRate: messages.playbackRate,
        mute: messages.mute,
        unmute: messages.unmute,
        loading: messages.loading,
    };
}

/** The message an error code shows, as `player-web` maps it. */
const ERROR_MESSAGE_KEYS: Partial<Record<PlayerError['code'], keyof NativePlayerMessages>> = {
    'unsupported-browser': 'errorUnsupportedBrowser',
    'key-required': 'errorKeyRequired',
    network: 'errorNetwork',
    media: 'errorMedia',
};

export function errorMessage(messages: NativePlayerMessages, error: PlayerError | null): string {
    const key = error ? ERROR_MESSAGE_KEYS[error.code] : undefined;
    return key ? messages[key] : messages.errorGeneric;
}
