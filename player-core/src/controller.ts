/**
 * {@link PlayerController} — the headless player.
 *
 * Owns everything that is not engine-specific: the munging pipeline, the state
 * store, coming-soon polling, the recovery ladder and the stall watchdog. The
 * engine is reached only through {@link PlayerAdapter}, so the same controller
 * drives hls.js on the web today and AVPlayer / ExoPlayer in a Capacitor shell
 * later.
 */

import { Emitter } from './emitter.js';
import { createDefaultServeStrategy } from './pipeline/blob-registry.js';
import type { SubtleLike } from './pipeline/decrypt.js';
import { isMissing, toPlayerError } from './pipeline/fetch.js';
import {
    DEFAULT_ANGLE_ID,
    loadMaster,
    mungeSource,
    type MasterInfo,
    type PipelineContext,
} from './pipeline/pipeline.js';
import { sortQualities, toQuality } from './pipeline/quality-cap.js';
import { Poller } from './poller.js';
import {
    RecoveryManager,
    StallWatchdog,
    resolveRecoveryPolicy,
} from './recovery.js';
import { SidecarLoader, pickDefaultChapterTrack } from './sidecars.js';
import { StateStore, createInitialState } from './store.js';
import {
    AUDIO_ONLY_ANGLE_ID,
    type Angle,
    type PlayerAdapter,
    type PlayerControllerApi,
    type PlayerError,
    type PlayerEventMap,
    type PlayerEventName,
    type PlayerSource,
    type PlayerState,
    type Quality,
    type RecoveryPolicy,
    type ServeStrategy,
    type Unsubscribe,
} from './types.js';

export interface PlayerControllerOptions {
    /** Injectable `fetch` (tests, auth-wrapped fetch, Capacitor HTTP). */
    fetchImpl?: typeof fetch;
    /** How munged text reaches the engine. Defaults to blob/object URLs. */
    serveStrategy?: ServeStrategy;
    /** Injectable WebCrypto; defaults to `globalThis.crypto.subtle`. */
    subtle?: SubtleLike;
}

export class PlayerController implements PlayerControllerApi {
    private readonly store = new StateStore();
    private readonly emitter = new Emitter<PlayerEventMap>();
    private readonly adapterSubscriptions: Unsubscribe[] = [];
    private readonly fetchImpl: typeof fetch;
    private readonly subtle?: SubtleLike;

    private serveStrategy: ServeStrategy | null;
    private policy: RecoveryPolicy = resolveRecoveryPolicy();
    private recovery: RecoveryManager;
    private watchdog: StallWatchdog;
    private poller: Poller | null = null;
    private sidecarLoader: SidecarLoader | null = null;

    /** Bumped by every load(); stale async work checks it and bails. */
    private generation = 0;
    private source: PlayerSource | null = null;
    private master: MasterInfo | null = null;
    private cache = new Map<string, string>();
    private qualityToVariant = new Map<string, string>();
    private startPosition = 0;
    private resumePlaying = false;
    private chapterTrackPinned = false;
    private lastProgress = 0;

    constructor(
        private readonly adapter: PlayerAdapter,
        options: PlayerControllerOptions = {},
    ) {
        this.fetchImpl =
            options.fetchImpl ??
            ((input: RequestInfo | URL, init?: RequestInit) =>
                globalThis.fetch(input, init));
        this.subtle = options.subtle;
        this.serveStrategy = options.serveStrategy ?? null;

        this.recovery = this.createRecovery();
        this.watchdog = this.createWatchdog();
        this.attachAdapter();
    }

    // -----------------------------------------------------------------------
    // Loading
    // -----------------------------------------------------------------------

    async load(source: PlayerSource): Promise<void> {
        if (this.state.lifecycle === 'destroyed') return;

        const generation = ++this.generation;
        const preserved = source.preservePosition
            ? this.adapter.getCurrentTime()
            : (source.startPosition ?? 0);
        const resume = source.preservePosition ? this.state.playing : false;

        this.teardownSource();
        this.source = source;
        this.policy = resolveRecoveryPolicy(source.recovery);
        this.recovery = this.createRecovery();
        this.watchdog = this.createWatchdog();
        this.startPosition = preserved;
        this.resumePlaying = resume;
        this.chapterTrackPinned = false;
        this.lastProgress = 0;
        this.cache = new Map();
        this.qualityToVariant = new Map();

        this.store.reset({
            ...createInitialState(),
            lifecycle: 'loading',
            playbackRate: this.state.playbackRate,
            maxHeight: source.maxHeight,
        });

        this.sidecarLoader = new SidecarLoader({
            fetchImpl: this.fetchImpl,
            serveStrategy: this.serve(),
            keyHex: source.keyHex,
            subtle: this.subtle,
        });

        try {
            const info = await loadMaster(source.masterUrl, this.context());
            if (generation !== this.generation) return;
            await this.applyMaster(generation, info);
        } catch (error) {
            if (generation !== this.generation) return;
            if (isMissing(error) && (source.poll?.enabled ?? true)) {
                // The engine may still hold the PREVIOUS source (teardown
                // stops our plumbing, not the adapter). "Coming soon" over
                // silently continuing stale playback is a lie — stop it.
                this.adapter.pause();
                this.store.setState({
                    lifecycle: 'waiting-for-master',
                    playing: false,
                });
                this.startPolling(generation, source);
                return;
            }
            this.fail(toPlayerError(error));
        }
    }

    /**
     * Wait for a master that is not published yet. The first check already
     * happened in `load()`, so the poller only runs the fixed-interval ones.
     * Finding it emits `master-available` and continues the load — it never
     * autoplays; the implementing project decides that.
     */
    private startPolling(generation: number, source: PlayerSource): void {
        let found: MasterInfo | null = null;

        this.poller = new Poller({
            intervalMs: source.poll?.intervalMs,
            immediate: false,
            check: async () => {
                if (generation !== this.generation) return false;
                try {
                    found = await loadMaster(source.masterUrl, this.context());
                    return true;
                } catch (error) {
                    if (isMissing(error)) return false;
                    throw error;
                }
            },
            onAvailable: () => {
                if (generation !== this.generation || !found) return;
                this.emitter.emit('master-available', undefined);
                void this.applyMaster(generation, found).catch((error) => {
                    if (generation === this.generation) {
                        this.fail(toPlayerError(error));
                    }
                });
            },
            onError: (error) => {
                if (generation === this.generation) {
                    this.fail(toPlayerError(error));
                }
            },
        });
        this.poller.start();
    }

    private async applyMaster(
        generation: number,
        info: MasterInfo,
    ): Promise<void> {
        this.master = info;
        const angleId = defaultAngleId(info.angles);

        this.store.setState({
            lifecycle: 'loading',
            bufferedEnd: 0,
            angles: info.angles,
            activeAngleId: angleId,
            audioTracks: info.audioTracks,
            activeAudioTrackId: info.audioTracks[0]?.id ?? null,
            subtitleTracks: info.subtitleTracks,
            isAudioOnly: info.nativelyAudioOnly,
            chapterTracks: this.prepareChapterTracks(),
        });

        await this.attachAngle(generation, angleId, {
            seekTo: this.startPosition,
            resume: this.resumePlaying,
        });
        if (generation !== this.generation) return;

        await this.attachSidecars(generation, info);
    }

    /** Steps 3–6 of the pipeline, plus engine attach. Used by load/setAngle/reload. */
    private async attachAngle(
        generation: number,
        angleId: string | null,
        options: { seekTo: number; resume: boolean },
    ): Promise<void> {
        const info = this.master;
        if (!info) return;

        const source = this.adapter.capabilities.nativeHls
            ? {
                  url: info.url,
                  isBlob: false,
                  ...(this.source?.keyHex
                      ? { keyHex: this.source.keyHex }
                      : {}),
              }
            : null;

        const munged = source
            ? null
            : await mungeSource(
                  info,
                  { angleId, maxHeight: this.source?.maxHeight },
                  this.context(),
              );
        if (generation !== this.generation) return;

        await this.adapter.loadSource(source ?? munged!.source);
        if (generation !== this.generation) return;

        this.store.setState({
            lifecycle: 'ready',
            activeAngleId: angleId,
            activeQualityId: 'auto',
            qualities: munged?.qualities ?? [],
            isAudioOnly:
                munged?.isAudioOnly ??
                (info.nativelyAudioOnly || angleId === AUDIO_ONLY_ANGLE_ID),
            error: null,
        });
        this.refreshQualities();
        this.refreshAudioTracks();

        if (options.seekTo > 0) this.adapter.seek(options.seekTo);
        if (options.resume) {
            await this.adapter.play().catch(() => undefined);
        }
    }

    private async attachSidecars(
        generation: number,
        info: MasterInfo,
    ): Promise<void> {
        const loader = this.sidecarLoader;
        if (!loader) return;

        try {
            const { tracks, adapterTracks } = await loader.loadSubtitleTracks(
                this.source?.sidecars?.subtitles,
            );
            if (generation !== this.generation) return;
            if (adapterTracks.length > 0) {
                this.adapter.setTextTracks(adapterTracks);
                this.store.setState({
                    subtitleTracks: [...info.subtitleTracks, ...tracks],
                });
            }
        } catch (error) {
            if (generation !== this.generation) return;
            // Subtitles are an enhancement — report, but keep playing.
            this.emitNonFatal(toPlayerError(error));
        }

        if (generation !== this.generation) return;
        this.selectDefaultChapterTrack(generation);
    }

    // -----------------------------------------------------------------------
    // Playback controls
    // -----------------------------------------------------------------------

    async play(): Promise<void> {
        await this.adapter.play();
    }

    pause(): void {
        this.adapter.pause();
    }

    togglePlay(): void {
        if (this.state.playing) this.adapter.pause();
        else void this.adapter.play().catch(() => undefined);
    }

    seek(seconds: number): void {
        this.adapter.seek(seconds);
        this.store.setState({ currentTime: seconds });
    }

    setPlaybackRate(rate: number): void {
        this.adapter.setPlaybackRate(rate);
        this.store.setState({ playbackRate: rate });
    }

    async setAngle(id: string): Promise<void> {
        if (!this.master || this.state.lifecycle === 'destroyed') return;
        if (id === this.state.activeAngleId) return;
        if (!this.state.angles.some((angle) => angle.id === id)) return;

        const generation = this.generation;
        const seekTo = this.adapter.getCurrentTime();
        const resume = this.state.playing;

        this.watchdog.stop();
        try {
            await this.attachAngle(generation, id, { seekTo, resume });
        } catch (error) {
            if (generation !== this.generation) return;
            this.fail(toPlayerError(error));
            return;
        }
        if (generation !== this.generation) return;
        this.emitter.emit('angle-changed', { angleId: id });
    }

    setQuality(id: string | 'auto'): void {
        const variantId =
            id === 'auto' ? 'auto' : (this.qualityToVariant.get(id) ?? id);
        this.adapter.setVariant(variantId);
        this.store.setState({ activeQualityId: id });
    }

    setAudioTrack(id: string): void {
        this.adapter.setAudioTrack(id);
        this.store.setState({ activeAudioTrackId: id });
        if (!this.chapterTrackPinned) {
            this.selectDefaultChapterTrack(this.generation);
        }
    }

    setSubtitleTrack(id: string | null): void {
        this.adapter.setActiveTextTrack(id);
        this.store.setState({ activeSubtitleTrackId: id });
    }

    setChapterTrack(id: string | null): void {
        this.chapterTrackPinned = true;
        void this.applyChapterTrack(this.generation, id);
    }

    // -----------------------------------------------------------------------
    // Store / events
    // -----------------------------------------------------------------------

    getState(): Readonly<PlayerState> {
        return this.store.getState();
    }

    subscribe(listener: (state: Readonly<PlayerState>) => void): Unsubscribe {
        return this.store.subscribe(listener);
    }

    on<E extends PlayerEventName>(
        event: E,
        listener: (payload: PlayerEventMap[E]) => void,
    ): Unsubscribe {
        return this.emitter.on(event, listener);
    }

    destroy(): void {
        if (this.state.lifecycle === 'destroyed') return;
        this.generation += 1;
        this.teardownSource();
        for (const unsubscribe of this.adapterSubscriptions) unsubscribe();
        this.adapterSubscriptions.length = 0;
        this.adapter.destroy();
        this.store.setState({ lifecycle: 'destroyed', playing: false });
        this.emitter.emit('destroyed', undefined);
        this.emitter.clear();
        this.store.clearListeners();
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private get state(): Readonly<PlayerState> {
        return this.store.getState();
    }

    private serve(): ServeStrategy {
        this.serveStrategy ??= createDefaultServeStrategy();
        return this.serveStrategy;
    }

    private context(): PipelineContext {
        return {
            fetchImpl: this.fetchImpl,
            serveStrategy: this.serve(),
            keyDelivery: this.adapter.capabilities.keyDelivery,
            keyHex: this.source?.keyHex,
            subtle: this.subtle,
            cache: this.cache,
        };
    }

    /** Release the previous generation's resources. */
    private teardownSource(): void {
        this.poller?.stop();
        this.poller = null;
        this.watchdog.stop();
        this.recovery.destroy();
        this.serveStrategy?.release();
        this.master = null;
    }

    private prepareChapterTracks() {
        this.sidecarLoader?.setChapters(this.source?.sidecars?.chapters);
        return this.sidecarLoader?.chapterTracks() ?? [];
    }

    private selectDefaultChapterTrack(generation: number): void {
        const tracks = this.state.chapterTracks;
        if (tracks.length === 0) return;
        const activeAudioLang = this.state.audioTracks.find(
            (track) => track.id === this.state.activeAudioTrackId,
        )?.lang;
        const id = pickDefaultChapterTrack(tracks, activeAudioLang);
        if (!id || id === this.state.activeChapterTrackId) return;
        void this.applyChapterTrack(generation, id);
    }

    private async applyChapterTrack(
        generation: number,
        id: string | null,
    ): Promise<void> {
        if (!id) {
            this.store.setState({ activeChapterTrackId: null, chapters: [] });
            return;
        }
        this.store.setState({ activeChapterTrackId: id });
        try {
            const chapters = (await this.sidecarLoader?.loadChapters(id)) ?? [];
            if (!this.isCurrentChapterTrack(generation, id)) return;
            this.store.setState({ chapters });
        } catch (error) {
            if (!this.isCurrentChapterTrack(generation, id)) return;
            this.store.setState({ chapters: [] });
            this.emitNonFatal(toPlayerError(error));
        }
    }

    /**
     * A language's cues arrive asynchronously; by then the user may have picked
     * another track (or another source). Only the selection still on screen
     * wins.
     */
    private isCurrentChapterTrack(generation: number, id: string): boolean {
        return (
            generation === this.generation &&
            this.state.activeChapterTrackId === id
        );
    }

    /**
     * Qualities the ENGINE actually offers win over the playlist-derived ones —
     * same id scheme either way, so `setQuality()` keeps working while the
     * variant ids stay adapter-private.
     */
    private refreshQualities(): void {
        const variants = this.adapter.getVariants();
        if (variants.length === 0) return;

        const map = new Map<string, string>();
        const qualities: Quality[] = [];
        for (const variant of variants) {
            const quality = toQuality(variant.height, variant.bandwidth);
            if (!map.has(quality.id)) qualities.push(quality);
            map.set(quality.id, variant.id);
        }
        this.qualityToVariant = map;

        const sorted = sortQualities(qualities);
        if (sameIds(sorted, this.state.qualities)) return;
        this.store.setState({ qualities: sorted });
    }

    private refreshAudioTracks(): void {
        const tracks = this.adapter.getAudioTracks();
        if (tracks.length === 0) return;

        const mapped = tracks.map((track) => ({
            id: track.id,
            lang: track.lang,
            label: track.label,
        }));
        if (sameIds(mapped, this.state.audioTracks)) return;

        const active = mapped.some(
            (track) => track.id === this.state.activeAudioTrackId,
        )
            ? this.state.activeAudioTrackId
            : (mapped[0]?.id ?? null);
        this.store.setState({
            audioTracks: mapped,
            activeAudioTrackId: active,
        });
    }

    private attachAdapter(): void {
        this.adapterSubscriptions.push(
            this.adapter.on('timeupdate', ({ currentTime }) => {
                this.store.setState({ currentTime });
                if (currentTime > this.lastProgress) {
                    this.lastProgress = currentTime;
                    this.recovery.notePlaybackHealthy();
                }
            }),
            this.adapter.on('durationchange', ({ duration }) => {
                this.store.setState({ duration });
            }),
            this.adapter.on('progress', ({ bufferedEnd }) => {
                this.store.setState({ bufferedEnd });
            }),
            this.adapter.on('playing', () => {
                this.store.setState({
                    playing: true,
                    ended: false,
                    stalled: false,
                });
                this.recovery.notePlaybackHealthy();
                this.watchdog.start();
            }),
            this.adapter.on('pause', () => {
                this.store.setState({ playing: false });
                this.watchdog.stop();
            }),
            this.adapter.on('ended', () => {
                this.store.setState({ playing: false, ended: true });
                this.watchdog.stop();
            }),
            // 'waiting' is normal buffering — the stall watchdog decides when
            // it has gone on long enough to be a problem.
            this.adapter.on('seeked', () => {
                this.store.setState({
                    currentTime: this.adapter.getCurrentTime(),
                });
            }),
            this.adapter.on('error', (payload) => {
                this.recovery.handleError(payload);
            }),
            this.adapter.on('variants-updated', () => this.refreshQualities()),
            this.adapter.on('audiotracks-updated', () =>
                this.refreshAudioTracks(),
            ),
        );
    }

    private createRecovery(): RecoveryManager {
        return new RecoveryManager(this.policy, {
            recoverInPlace: (category) =>
                this.adapter.recover?.(category) ?? false,
            reload: async (attempt) => {
                const generation = this.generation;
                const seekTo = this.adapter.getCurrentTime();
                const resume = this.state.playing;
                await this.attachAngle(generation, this.state.activeAngleId, {
                    seekTo,
                    resume,
                });
                if (generation !== this.generation) return;
                this.emitter.emit('recovered', { attempt });
            },
            onFatal: (error) => this.fail(error),
        });
    }

    private createWatchdog(): StallWatchdog {
        return new StallWatchdog(this.policy, {
            getCurrentTime: () => this.adapter.getCurrentTime(),
            seek: (seconds) => this.adapter.seek(seconds),
            onStalled: (stalled) => this.store.setState({ stalled }),
            onWedged: () =>
                this.recovery.handleError({ category: 'media', fatal: true }),
        });
    }

    private fail(error: PlayerError): void {
        this.watchdog.stop();
        // Same reasoning as the waiting-for-master path: the adapter may
        // still be playing a previous source; an error surface over live
        // playback misstates both.
        this.adapter.pause();
        this.store.setState({ lifecycle: 'error', error, playing: false });
        this.emitter.emit('error', error);
    }

    private emitNonFatal(error: PlayerError): void {
        this.emitter.emit('error', { ...error, fatal: false });
    }
}

function defaultAngleId(angles: Angle[]): string | null {
    if (angles.length === 0) return null;
    const preferred =
        angles.find((angle) => angle.isDefault) ??
        angles.find((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID) ??
        angles[0];
    return preferred?.id ?? DEFAULT_ANGLE_ID;
}

function sameIds(a: { id: string }[], b: readonly { id: string }[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((item, index) => item.id === b[index]?.id);
}
