import type { PluginListenerHandle } from '@capacitor/core';
import type {
    BridgeCapabilities,
    BridgeEventName,
    BridgeInfo,
    LuminaryPlayerPlugin,
    ResumeResult,
} from '@luminary-media-converter/player-native';
// The reference native side the conformance scenarios prove against: the registry, validation,
// asset store, key and emission rules, in TypeScript.
import { PlayerRegistry } from '../../../src/test-support/conformance/reference/PlayerRegistry';
import type { PlayerHost } from '../../../src/test-support/conformance/reference/PlayerHost';
import type { VirtualClock } from '../../../src/test-support/conformance/reference/clock';
import type { JsonObject } from '../../../src/test-support/conformance/scenario';

/** Real time in the shape of the reference side's clock. */
class RealtimeClock {
    now(): number {
        return performance.now() / 1000;
    }
    schedule(delay: number, run: () => void): () => void {
        const timer = setTimeout(run, delay * 1000);
        return () => clearTimeout(timer);
    }
    advance(): void {}
}

interface Media {
    masterUri: string;
    duration: number;
    hasVideo: boolean;
    tracks: { id: string; lang?: string; label: string }[];
    activeTrack: string | null;
    variants: { id: string; height?: number; bandwidth: number }[];
}

/**
 * A Capacitor-free native side for the browser: the reference registry behind the plugin's call
 * surface, with a driver standing in for the engine. It lets Native mode, and the whole
 * TypeScript half of the bridge, be stress-tested without a device. There is no picture: bridge v1
 * shows video only in native full-screen.
 */
export class SimulatedNativePlugin implements LuminaryPlayerPlugin {
    /** Multiplies every simulated engine delay; above 1 makes a slow device on purpose. */
    latencyScale = 1;

    private readonly capabilities: BridgeCapabilities;
    private readonly registry: PlayerRegistry;
    private readonly engineLog: JsonObject[] = [];
    private readonly listeners = new Map<string, Set<(event: never) => void>>();
    private readonly media = new WeakMap<PlayerHost, Media>();
    private readonly tickers = new WeakMap<PlayerHost, ReturnType<typeof setInterval>>();
    /** One pending answer per kind per player: an engine acts on the latest command, not a queue. */
    private readonly pending = new WeakMap<PlayerHost, Map<string, ReturnType<typeof setTimeout>>>();

    constructor(capabilities: Partial<BridgeCapabilities> = {}) {
        this.capabilities = {
            variantSwitching: true,
            pictureInPicture: false,
            renderText: false,
            live: false,
            chunkWarming: false,
            backgroundAudio: false,
            inlineVideo: false,
            muting: false,
            subtitleSelection: false,
            maxPlayers: 1,
            ...capabilities,
        };
        this.registry = new PlayerRegistry(
            this.capabilities as unknown as JsonObject,
            new RealtimeClock() as unknown as VirtualClock,
            this.engineLog,
            (event) => this.dispatch(event.name as string, event.payload as JsonObject),
        );
    }

    // The call surface: every call crosses as JSON, as it would over Capacitor.

    private call<T>(method: string, args: unknown = {}): Promise<T> {
        const host = this.registry.current;
        try {
            const wire = JSON.parse(JSON.stringify(args ?? {})) as JsonObject;
            const result = this.registry.call(method, wire);
            this.drive(this.registry.current ?? host);
            return Promise.resolve(result as T);
        } catch (error) {
            const rejection = PlayerRegistry.rejectionOf(error);
            if (!rejection) return Promise.reject(error);
            return Promise.reject(Object.assign(new Error(rejection.message), { code: rejection.code }));
        }
    }

    getInfo = () => this.call<BridgeInfo>('getInfo');
    reset = () => this.call<void>('reset');
    create = (args: Parameters<LuminaryPlayerPlugin['create']>[0]) => this.call<{ playerId: string }>('create', args);
    load = (args: Parameters<LuminaryPlayerPlugin['load']>[0]) => this.call<void>('load', args);
    putAssets = (args: Parameters<LuminaryPlayerPlugin['putAssets']>[0]) => this.call<void>('putAssets', args);
    putLive = (args: Parameters<LuminaryPlayerPlugin['putLive']>[0]) => this.call<void>('putLive', args);
    releaseAssets = (args: Parameters<LuminaryPlayerPlugin['releaseAssets']>[0]) => this.call<void>('releaseAssets', args);
    reattach = (args: Parameters<LuminaryPlayerPlugin['reattach']>[0]) => this.call<void>('reattach', args);
    play = (args: { playerId: string }) => this.call<void>('play', args);
    pause = (args: { playerId: string }) => this.call<void>('pause', args);
    seek = (args: Parameters<LuminaryPlayerPlugin['seek']>[0]) => this.call<void>('seek', args);
    setRate = (args: Parameters<LuminaryPlayerPlugin['setRate']>[0]) => this.call<void>('setRate', args);
    setVariant = (args: Parameters<LuminaryPlayerPlugin['setVariant']>[0]) => this.call<void>('setVariant', args);
    setAudioTrack = (args: Parameters<LuminaryPlayerPlugin['setAudioTrack']>[0]) => this.call<void>('setAudioTrack', args);
    warmChunks = (args: Parameters<LuminaryPlayerPlugin['warmChunks']>[0]) => this.call<void>('warmChunks', args);
    resumed = (args: { playerId: string }) => this.call<ResumeResult>('resumed', args);
    destroy = (args: { playerId: string }) => this.call<void>('destroy', args);

    setMuted = (args: Parameters<LuminaryPlayerPlugin['setMuted']>[0]) => this.call<void>('setMuted', args);
    setSubtitleTrack = (args: Parameters<LuminaryPlayerPlugin['setSubtitleTrack']>[0]) => this.call<void>('setSubtitleTrack', args);
    startPictureInPicture = (args: Parameters<LuminaryPlayerPlugin['startPictureInPicture']>[0]) => this.call<void>('startPictureInPicture', args);
    setInlineFrame = (args: Parameters<LuminaryPlayerPlugin['setInlineFrame']>[0]) => this.call<void>('setInlineFrame', args);
    enterFullscreen = async (args: { playerId: string }) => {
        await this.call<void>('enterFullscreen', args);
        this.dispatch('presentationchange', { playerId: args.playerId, state: 'fullscreen' });
    };

    exitFullscreen = async (args: { playerId: string }) => {
        await this.call<void>('exitFullscreen', args);
        this.dispatch('presentationchange', { playerId: args.playerId, state: 'inline' });
    };

    addListener<E extends BridgeEventName>(event: E, listener: (event: never) => void): Promise<PluginListenerHandle> {
        let set = this.listeners.get(event);
        if (!set) this.listeners.set(event, (set = new Set()));
        set.add(listener);
        return Promise.resolve({ remove: async () => void set.delete(listener) });
    }

    private dispatch(name: string, payload: JsonObject): void {
        // Native events reach JavaScript a hop later, never inside the call that caused them.
        queueMicrotask(() => {
            for (const listener of this.listeners.get(name) ?? []) listener(payload as never);
        });
    }

    // The engine's side: answers to the commands PlayerHost made, after a device-like delay.

    private drive(host: PlayerHost | null): void {
        for (const command of this.engineLog.splice(0)) {
            if (!host) continue;
            switch (command.method) {
                case 'load':
                    this.loadMedia(host, command.masterUri as string);
                    break;
                case 'reattach': {
                    const media = this.media.get(host);
                    if (media) this.loadMedia(host, media.masterUri);
                    break;
                }
                case 'play':
                    this.later(host, 'transport', 60, () => {
                        host.engine.signal('playing', {});
                        this.startTicking(host);
                    });
                    break;
                case 'pause':
                    this.later(host, 'transport', 40, () => {
                        this.stopTicking(host);
                        host.engine.signal('paused', {});
                    });
                    break;
                case 'seek': {
                    const duration = this.media.get(host)?.duration ?? Infinity;
                    const position = Math.min(Math.max(0, command.position as number), duration);
                    this.later(host, 'seek', 150, () => host.engine.signal('seeked', { position }));
                    break;
                }
                case 'setAudioTrack': {
                    const media = this.media.get(host);
                    const id = command.id as string;
                    if (media?.tracks.some((track) => track.id === id)) {
                        this.later(host, 'audio', 90, () => {
                            media.activeTrack = id;
                            host.engine.signal('tracks', { tracks: media.tracks, activeId: id });
                        });
                    }
                    break;
                }
                case 'destroy':
                    this.stopTicking(host);
                    break;
            }
        }
    }

    /** What an engine learns from the playlists it was served: duration, renditions, languages. */
    private loadMedia(host: PlayerHost, masterUri: string): void {
        this.stopTicking(host);
        const master = this.text(host, masterUri);
        if (master === null) return; // A missing master never becomes ready; the health board times it out.
        const lines = master.split('\n');
        const variants: Media['variants'] = [];
        const tracks: Media['tracks'] = [];
        let activeTrack: string | null = null;
        let firstPlaylist: string | undefined;
        let hasVideo = false;
        lines.forEach((line, i) => {
            if (line.startsWith('#EXT-X-STREAM-INF:')) {
                const bandwidth = Number(/BANDWIDTH=(\d+)/.exec(line)?.[1] ?? 0);
                const height = /RESOLUTION=\d+x(\d+)/.exec(line)?.[1];
                if (height) hasVideo = true;
                variants.push({ id: `${height ?? 0}_${bandwidth}`, height: height ? Number(height) : undefined, bandwidth });
                firstPlaylist ??= lines[i + 1]?.trim();
            } else if (line.startsWith('#EXT-X-MEDIA:') && line.includes('TYPE=AUDIO')) {
                const name = /NAME="([^"]*)"/.exec(line)?.[1] ?? 'Audio';
                const id = `${/GROUP-ID="([^"]*)"/.exec(line)?.[1] ?? 'audio'}:${name}`;
                tracks.push({ id, lang: /LANGUAGE="([^"]*)"/.exec(line)?.[1], label: name });
                if (line.includes('DEFAULT=YES') || activeTrack === null) activeTrack = id;
            }
        });
        const playlist = firstPlaylist ? this.text(host, firstPlaylist) : null;
        const duration = [...(playlist ?? '').matchAll(/#EXTINF:([\d.]+)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
        const media: Media = { masterUri, duration, hasVideo, tracks, activeTrack, variants };
        this.media.set(host, media);

        this.later(host, 'load', 180, () => {
            host.engine.signal('readyToPlay', { duration, hasVideo });
            if (tracks.length) host.engine.signal('tracks', { tracks, activeId: activeTrack });
            if (hasVideo) host.engine.signal('variants', { variants });
            host.engine.signal('bufferedTo', { end: Math.min(duration, host.engine.position() + 20) });
        });
    }

    private text(host: PlayerHost, uri: string): string | null {
        const route = host.router.route(uri);
        return 'served' in route ? new TextDecoder().decode(route.served.bytes) : null;
    }

    /** Once a second while playing: the buffer runs ahead, and the end is noticed. */
    private startTicking(host: PlayerHost): void {
        this.stopTicking(host);
        this.tickers.set(host, setInterval(() => {
            if (host.engine.listener === null) return this.stopTicking(host);
            const media = this.media.get(host);
            const position = host.engine.position();
            if (media && position >= media.duration) {
                this.stopTicking(host);
                host.engine.signal('ended', {});
                return;
            }
            host.engine.signal('bufferedTo', { end: Math.min(media?.duration ?? position + 30, position + 30) });
        }, 1000));
    }

    private stopTicking(host: PlayerHost): void {
        clearInterval(this.tickers.get(host));
        this.tickers.delete(host);
    }

    /**
     * A signal after [ms] of simulated engine time. It replaces any still pending of the same
     * [kind], and is dropped if the player was destroyed meanwhile.
     */
    private later(host: PlayerHost, kind: string, ms: number, signal: () => void): void {
        let slots = this.pending.get(host);
        if (!slots) this.pending.set(host, (slots = new Map()));
        clearTimeout(slots.get(kind));
        slots.set(kind, setTimeout(() => {
            slots.delete(kind);
            if (host.engine.listener !== null) signal();
        }, ms * this.latencyScale));
    }
}
