/**
 * Minimal hls.js stand-in: only the surface {@link HlsJsAdapter} touches.
 * Kept in its own module so `vi.mock('hls.js')` factories can import it
 * (factories cannot close over test-file locals).
 */

export interface FakeLoaderCall {
    context: { url: string };
    config: unknown;
    callbacks: {
        onSuccess: (...args: unknown[]) => void;
        onError: (...args: unknown[]) => void;
    };
}

/** Every request the *base* loader was asked to perform (i.e. real network). */
export const baseLoaderCalls: FakeLoaderCall[] = [];

function createStats() {
    const timing = { start: 0, first: 0, end: 0 };
    return {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: { ...timing },
        parsing: { start: 0, end: 0 },
        buffering: { ...timing },
    };
}

export class BaseLoaderStub {
    context: unknown = null;
    stats = createStats();

    load(
        context: FakeLoaderCall['context'],
        config: unknown,
        callbacks: FakeLoaderCall['callbacks'],
    ): void {
        baseLoaderCalls.push({ context, config, callbacks });
    }

    abort(): void {}
    destroy(): void {}
}

export interface FakeLevel {
    height: number;
    bitrate: number;
}

export interface FakeAudioTrack {
    id: number;
    name: string;
    lang?: string;
}

export class FakeHls {
    static instances: FakeHls[] = [];
    static supported = true;

    static isSupported(): boolean {
        return FakeHls.supported;
    }

    static readonly Events = {
        MEDIA_ATTACHED: 'hlsMediaAttached',
        MANIFEST_PARSED: 'hlsManifestParsed',
        LEVELS_UPDATED: 'hlsLevelsUpdated',
        LEVEL_SWITCHED: 'hlsLevelSwitched',
        AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
        AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched',
        ERROR: 'hlsError',
    };

    static readonly ErrorTypes = {
        NETWORK_ERROR: 'networkError',
        MEDIA_ERROR: 'mediaError',
        OTHER_ERROR: 'otherError',
    };

    static readonly DefaultConfig = { loader: BaseLoaderStub };

    readonly config: Record<string, unknown>;
    levels: FakeLevel[] = [];
    currentLevel = -1;
    audioTracks: FakeAudioTrack[] = [];
    audioTrack = -1;
    media: HTMLMediaElement | null = null;
    url: string | null = null;
    destroyed = false;
    recoverMediaError = (): void => {
        this.recoverMediaErrorCalls += 1;
    };
    startLoad = (): void => {
        this.startLoadCalls += 1;
    };
    recoverMediaErrorCalls = 0;
    startLoadCalls = 0;

    private handlers = new Map<string, Set<(event: string, data: unknown) => void>>();

    constructor(config: Record<string, unknown> = {}) {
        this.config = config;
        FakeHls.instances.push(this);
    }

    on(event: string, handler: (event: string, data: unknown) => void): void {
        let set = this.handlers.get(event);
        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }
        set.add(handler);
    }

    /** Test-side helper: fire an hls.js event. */
    trigger(event: string, data: unknown = {}): void {
        for (const handler of this.handlers.get(event) ?? []) handler(event, data);
    }

    attachMedia(media: HTMLMediaElement): void {
        this.media = media;
    }

    loadSource(url: string): void {
        this.url = url;
    }

    destroy(): void {
        this.destroyed = true;
        this.handlers.clear();
    }
}

/** Resets module-level recording between tests. */
export function resetHlsMock(): void {
    FakeHls.instances.length = 0;
    FakeHls.supported = true;
    baseLoaderCalls.length = 0;
}
