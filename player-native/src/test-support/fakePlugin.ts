/**
 * A {@link LuminaryPlayerPlugin} with no native side: it records every call and
 * lets a spec emit events as native would. Excluded from the tsc build (see
 * tsconfig.json) — it exists only for `*.spec.ts`.
 */

import type { PluginListenerHandle } from '@capacitor/core';
import {
    PROTOCOL_VERSION,
    type BridgeCapabilities,
    type BridgeErrorCode,
    type BridgeEvent,
    type BridgeEventMap,
    type BridgeEventName,
    type BridgeInfo,
    type LuminaryPlayerPlugin,
    type ResumeResult,
} from '../bridge.js';

export interface RecordedCall {
    method: string;
    args: unknown;
}

type Listener = (event: never) => void;

export type ScriptedAnswer = { result: unknown } | { rejects: BridgeErrorCode };

export const DEFAULT_CAPABILITIES: BridgeCapabilities = {
    variantSwitching: false,
    pictureInPicture: false,
    renderText: false,
    live: false,
    chunkWarming: false,
    backgroundAudio: false,
    inlineVideo: false,
    muting: false,
    subtitleSelection: false,
    maxPlayers: 1,
};

/** A rejection shaped like Capacitor's: a message and a `code`. */
export class FakeRejection extends Error {
    constructor(readonly code: BridgeErrorCode) {
        super(code);
    }
}

export class FakePlugin implements LuminaryPlayerPlugin {
    readonly calls: RecordedCall[] = [];
    info: BridgeInfo;
    /** What `resumed()` answers; a spec sets it before triggering a resume. */
    resumeResult: ResumeResult | null = null;
    /** Answers a call before the defaults do; `undefined` falls through to them. */
    script: ((method: string, args: unknown) => ScriptedAnswer | undefined) | null = null;
    private readonly listeners = new Map<string, Set<Listener>>();
    private readonly failures = new Map<string, BridgeErrorCode>();
    private players = 0;

    constructor(capabilities: Partial<BridgeCapabilities> = {}, protocolVersion = PROTOCOL_VERSION) {
        this.info = {
            protocolVersion,
            platform: 'ios',
            capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
        };
    }

    /** Every later call to `method` rejects with `code`. */
    failWith(method: string, code: BridgeErrorCode): void {
        this.failures.set(method, code);
    }

    /** Arguments of every call to `method`, in order. */
    argsOf<T = Record<string, unknown>>(method: string): T[] {
        return this.calls.filter((call) => call.method === method).map((call) => call.args as T);
    }

    methods(): string[] {
        return this.calls.map((call) => call.method);
    }

    /** Emits as native would, stamped with the ids a spec names. */
    emit<E extends BridgeEventName>(
        name: E,
        ids: { playerId: string; loadId: string },
        payload: BridgeEventMap[E],
    ): void {
        const event = { ...payload, ...ids } as BridgeEvent<E>;
        for (const listener of [...(this.listeners.get(name) ?? [])]) {
            (listener as (event: BridgeEvent<E>) => void)(event);
        }
    }

    listenerCount(): number {
        let count = 0;
        for (const set of this.listeners.values()) count += set.size;
        return count;
    }

    private record<T>(method: string, args: unknown, answer: T): Promise<T> {
        this.calls.push({ method, args });
        const scripted = this.script?.(method, args);
        if (scripted) {
            return 'rejects' in scripted
                ? Promise.reject(new FakeRejection(scripted.rejects))
                : Promise.resolve(scripted.result as T);
        }
        const code = this.failures.get(method);
        return code ? Promise.reject(new FakeRejection(code)) : Promise.resolve(answer);
    }

    getInfo = () => this.record('getInfo', undefined, this.info);
    reset = () => this.record('reset', undefined, undefined);
    create = (args: unknown) => this.record('create', args, { playerId: `player-${++this.players}` });
    load = (args: unknown) => this.record('load', args, undefined);
    putAssets = (args: unknown) => this.record('putAssets', args, undefined);
    putLive = (args: unknown) => this.record('putLive', args, undefined);
    releaseAssets = (args: unknown) => this.record('releaseAssets', args, undefined);
    reattach = (args: unknown) => this.record('reattach', args, undefined);
    play = (args: unknown) => this.record('play', args, undefined);
    pause = (args: unknown) => this.record('pause', args, undefined);
    seek = (args: unknown) => this.record('seek', args, undefined);
    setRate = (args: unknown) => this.record('setRate', args, undefined);
    setVariant = (args: unknown) => this.record('setVariant', args, undefined);
    setAudioTrack = (args: unknown) => this.record('setAudioTrack', args, undefined);
    warmChunks = (args: unknown) => this.record('warmChunks', args, undefined);
    setInlineFrame = (args: unknown) => this.record('setInlineFrame', args, undefined);
    setMuted = (args: unknown) => this.record('setMuted', args, undefined);
    setSubtitleTrack = (args: unknown) => this.record('setSubtitleTrack', args, undefined);
    startPictureInPicture = (args: unknown) => this.record('startPictureInPicture', args, undefined);
    enterFullscreen = (args: unknown) => this.record('enterFullscreen', args, undefined);
    exitFullscreen = (args: unknown) => this.record('exitFullscreen', args, undefined);
    destroy = (args: unknown) => this.record('destroy', args, undefined);

    resumed = (args: unknown) => {
        if (!this.resumeResult && !this.script) throw new Error('FakePlugin: set resumeResult first');
        return this.record('resumed', args, this.resumeResult as ResumeResult);
    };

    addListener = <E extends BridgeEventName>(
        event: E,
        listener: (event: BridgeEvent<E>) => void,
    ): Promise<PluginListenerHandle> => {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        const entry = listener as Listener;
        set.add(entry);
        return Promise.resolve({
            remove: async () => {
                set.delete(entry);
            },
        });
    };
}
