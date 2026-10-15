import { vi } from 'vitest';
import { createInitialState } from '@luminary-media-converter/player-core';
import type {
    PlayerControllerApi,
    PlayerState,
    ThumbnailSpriteCue,
} from '@luminary-media-converter/player-core';
import { DEFAULT_MESSAGES, type PlayerMessages } from '../src/messages';

/** A complete, boring {@link PlayerState} with overrides applied on top. */
export function createState(partial: Partial<PlayerState> = {}): PlayerState {
    return { ...createInitialState(), lifecycle: 'ready', ...partial };
}

export interface FakeController extends PlayerControllerApi {
    /** Publishes a state patch to every subscriber. */
    setState(patch: Partial<PlayerState>): void;
    /** The cues `thumbnailAt` will answer from. */
    setThumbnails(cues: ThumbnailSpriteCue[]): void;
}

/**
 * A fake implementing the frozen {@link PlayerControllerApi}. Components are
 * coded against the interface, so no test ever touches the concrete
 * `PlayerController` from player-core.
 */
export function createFakeController(initial: Partial<PlayerState> = {}): FakeController {
    let state = createState(initial);
    let thumbnails: ThumbnailSpriteCue[] = [];
    const listeners = new Set<(next: Readonly<PlayerState>) => void>();

    return {
        load: vi.fn(async () => {}),
        destroy: vi.fn(),
        play: vi.fn(async () => {}),
        pause: vi.fn(),
        togglePlay: vi.fn(),
        seek: vi.fn(),
        setPlaybackRate: vi.fn(),
        setAngle: vi.fn(async () => {}),
        setQuality: vi.fn(),
        setAudioTrack: vi.fn(),
        setSubtitleTrack: vi.fn(),
        setChapterTrack: vi.fn(),
        thumbnailAt: (seconds) =>
            thumbnails.find(
                (cue) => seconds >= cue.startTime && seconds < cue.endTime,
            ) ?? null,
        getState: () => state,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        on: vi.fn(() => () => {}) as PlayerControllerApi['on'],
        setState(patch) {
            state = { ...state, ...patch };
            for (const listener of [...listeners]) listener(state);
        },
        setThumbnails(cues) {
            thumbnails = cues;
        },
    };
}

export function messages(overrides: Partial<PlayerMessages> = {}): PlayerMessages {
    return { ...DEFAULT_MESSAGES, ...overrides };
}
