import type { Component } from 'vue';
import type { PlayerControllerApi, PlayerSource, PlayerState } from '@luminary-media-converter/player-core';

/**
 * How a source is played.
 * - `web`: `player-web` (Video.js) over the LMC pipeline, in the page.
 * - `native`: the Capacitor plugin (ExoPlayer / AVPlayer) behind `player-native`'s bridge.
 * - `youtube`: `player-web`'s YouTube mode; the LMC pipeline is bypassed on every platform.
 */
export type PlaybackMode = 'web' | 'native' | 'youtube';

export interface ModeInfo {
    id: PlaybackMode;
    label: string;
    /** False when this target cannot play it here; [reason] says why. */
    available: boolean;
    reason?: string;
}

/**
 * What every player component exposes, the same as `player-web`'s `LuminaryPlayer`. The native
 * component matches it (plan 00, phase 2), so a host drives either through one surface.
 */
export interface PlayerHandle {
    /** Null in YouTube mode, which has no controller. */
    readonly controller: PlayerControllerApi | null;
    readonly state: Readonly<PlayerState>;
    play(): void | Promise<void>;
    pause(): void;
    seek(seconds: number): void;
    enterFullscreen(): void | Promise<void>;
    exitFullscreen(): void | Promise<void>;
    /** Only the native component has these: what native does for controls the host draws itself. */
    readonly muted?: boolean;
    readonly canMute?: boolean;
    readonly canPictureInPicture?: boolean;
    setMuted?(muted: boolean): void;
    startPictureInPicture?(): void;
}

/**
 * The props every player component takes. It emits `timeupdate(currentTime, duration)`,
 * `loadedmetadata` and `ended`, as `LuminaryPlayer` does.
 */
export interface PlayerProps {
    source: PlayerSource;
    poster?: string;
    preferredLanguage?: string;
}

/** The video player a build target supplies; the host never imports an implementation. */
export interface VideoPlayerService {
    /** Which build this is: a browser build, or a Capacitor build through `VITE_NATIVE_IMPL_DIR`. */
    readonly target: 'web' | 'native';
    /** Every mode, with whether this target can play it here. */
    readonly modes: readonly ModeInfo[];
    /** The mode a host would choose for this source on this target. */
    modeFor(source: PlayerSource): PlaybackMode;
    /** The component that plays [mode]; rendered with {@link PlayerProps}, exposing a {@link PlayerHandle}. */
    component(mode: PlaybackMode): Component;
}
