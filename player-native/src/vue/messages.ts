/**
 * Every string `NativeLuminaryPlayer` renders: the ones `player-web`'s `PlayerMessages` has for
 * the same surfaces, with the same defaults and the same names, so a host passes one `messages`
 * object to either player. Native full-screen draws its own labels (plan 05).
 */

import type { PlayerError } from '@luminary-media-converter/player-core';

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
};

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
