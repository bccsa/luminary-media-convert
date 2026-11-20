/**
 * {@link PlayerController} — the headless player.
 *
 * Owns what no engine can: the munging pipeline, the state store and
 * coming-soon polling. Detection and recovery belong to the engine, which
 * reaches back through exactly one door — `reload-requested`, the rebuild of a
 * munged source that only this code knows how to perform. The engine is reached
 * through {@link PlayerAdapter}, so the same controller drives Video.js on the
 * web today and AVPlayer / ExoPlayer in a Capacitor shell later.
 */

import { Emitter } from './emitter.js';
import type { SubtleLike } from './pipeline/decrypt.js';
import { isMissing, toPlayerError } from './pipeline/fetch.js';
import {
    DEFAULT_ANGLE_ID,
    dedupeByName,
    loadMaster,
    mungeSource,
    type MasterInfo,
    type MungeResult,
    type PipelineContext,
    type ServeMemo,
} from './pipeline/pipeline.js';
import { sortQualities, toQuality } from './pipeline/quality-cap.js';
import { Poller } from './poller.js';
import { readSubtitleCues } from './pipeline/subtitle-cues.js';
import type { LyricCue } from './lyrics.js';
import {
    DEFAULT_LEAD_SECONDS,
    DEFAULT_WARM_BYTES,
    buildChunkSchedules,
} from './prefetch.js';
import { SidecarLoader, pickDefaultChapterTrack } from './sidecars.js';
import {
    findThumbnailCue,
    resolveThumbnails,
    thumbnailsCoverDuration,
    type ThumbnailSpriteCue,
} from '@luminary-media-converter/hls-core';
import { StateStore, createInitialState } from './store.js';
import { angleForAudio } from './angleForAudio.js';
import {
    findPreferredTrack,
    matchesPreferredLanguage,
} from './audioTrackLanguage.js';
import { SleepTimer } from './sleepTimer.js';
import { chapterIndexAt } from './chapters.js';
import {
    AUDIO_ONLY_ANGLE_ID,
    DATA_SAVER_START_BPS,
    type AdapterErrorPayload,
    type AdapterTextTrack,
    type Angle,
    type ChunkWarmOptions,
    type PlayerAdapter,
    type PlayerControllerApi,
    type PlayerError,
    type PlayerEventMap,
    type PlayerEventName,
    type PlayerSource,
    type PlayerState,
    type Quality,
    type RecoveryPolicy,
    resolveRecoveryPolicy,
    type SleepTimerOption,
    type ServeStrategy,
    type Unsubscribe,
} from './types.js';

export interface PlayerControllerOptions {
    /** Injectable `fetch` (tests, auth-wrapped fetch, Capacitor HTTP). */
    fetchImpl?: typeof fetch;
    /**
     * How munged text reaches the engine: blob URLs on the web
     * (`BlobServeStrategy`, in the player packages), a loopback server or file
     * URIs in a native shell.
     *
     * Required, and deliberately so. It used to default to blob URLs, which
     * meant a native shell that forgot to pass one was handed URLs its player
     * cannot read, silently, at runtime. It is also the seam the whole native
     * port hangs off and, until this became required, no real host had ever
     * exercised it — every one of them fell through to the default.
     */
    serveStrategy: ServeStrategy;
    /** Injectable WebCrypto; defaults to `globalThis.crypto.subtle`. */
    subtle?: SubtleLike;
    /**
     * Chunk warming for byte-range output. The schedules are built here (see
     * `prefetch.ts`) and the loop that acts on them runs in the adapter
     * (`PlayerAdapter.warmChunks`); the policy — on or off, how far ahead, how
     * much — stays here so every platform warms the same way.
     *
     * It arms itself only when the media playlists actually carry byte ranges,
     * so the switch exists for hosts that want it off outright — a proxy that
     * already warms, a metered connection, a test that wants no background
     * traffic.
     */
    prefetch?: {
        enabled?: boolean;
        leadSeconds?: number;
        warmBytes?: number;
        /**
         * Console instrumentation for the warming, off by default. The
         * requests are deliberately hard to spot in a network tab — one small
         * range per chunk among hundreds of media requests — so this narrates
         * them instead: schedule shape at load, each warm with its trigger
         * context, and swallowed failures.
         */
        debug?: boolean;
    };
}

/** An attach under way; see `PlayerController.attaching`. */
interface InFlightAttach {
    angleId: string | null;
    /** The position the engine is to be put back at once it has this source. */
    seekTo: number;
    /** Whether it plays on once it has. */
    resume: boolean;
    /**
     * The engine holds this source and has been put at `seekTo`: its own clock
     * is the truth again. Set before `play()` is awaited, which can take as
     * long as the new source takes to buffer — a seek made in that time is the
     * viewer's, and an attach starting then has to carry it, not `seekTo`.
     */
    placed: boolean;
    /**
     * `seekTo` and `resume` were read off the engine, while it held a source
     * of this video it had been put in place in — not handed down by a load,
     * nor by an attach the engine had not finished taking. Until a source is
     * handed over after this attach began (`handovers` still equals
     * {@link readAt}), the engine plays on what it played then, and its own
     * clock and play state are fresher than this record: they carry a seek or
     * a pause the viewer made while this attach fetched its playlists.
     */
    fromEngine: boolean;
    /** `handovers` when this attach began. */
    readAt: number;
    /** It carries an angle change nobody has been told of yet. */
    announce: boolean;
    /** Settles when this attach is over, and only after any that superseded it are; never rejects. */
    done: Promise<void>;
}

export class PlayerController implements PlayerControllerApi {
    private readonly store = new StateStore();
    private readonly emitter = new Emitter<PlayerEventMap>();
    private readonly adapterSubscriptions: Unsubscribe[] = [];
    private readonly fetchImpl: typeof fetch;
    private readonly subtle?: SubtleLike;

    private readonly serveStrategy: ServeStrategy;
    private policy: RecoveryPolicy = resolveRecoveryPolicy();
    private poller: Poller | null = null;
    private sidecarLoader: SidecarLoader | null = null;
    /** Parsed scrub-preview cues for the current source; empty when there are none. */
    private thumbnailCues: ThumbnailSpriteCue[] = [];
    /**
     * The strip {@link thumbnailCues} come from, or are being read from. An
     * angle switch only reads a strip when this changes, and a read that
     * finishes after another angle has asked for a different strip is dropped.
     */
    private thumbnailStripUrl: string | undefined;

    /** The sleep timer; a minutes timer outlives a source, so it is not torn down with one. */
    private readonly sleep = new SleepTimer(
        () => this.adapter.pause(),
        (sleepTimer) => this.store.setState({ sleepTimer }),
    );

    /** Bumped by every load(); stale async work checks it and bails. */
    private generation = 0;
    /**
     * The attach in flight, if any. Within one source an attach is superseded
     * by the next one: an angle switch, a quality cap or a re-munge that starts
     * while another is still munging or loading replaces it, and the one
     * replaced neither plays nor announces. It does not reach the engine
     * either, unless the engine was already taking its source when it was
     * replaced; then, if nothing has been handed over since (see
     * {@link handovers}), the state describes it until the replacement lands,
     * since that is what the engine holds. Checked by identity beside the
     * generation, which only a new source moves.
     *
     * It also carries what an attach started mid-attach has to start from: the
     * angle on its way in, which `state.activeAngleId` does not show until it
     * lands, and the position and play state, which the engine cannot tell
     * while it is loading a new source. Cleared by `load()`, and by the attach
     * itself when it finishes.
     */
    private attaching: InFlightAttach | null = null;
    /**
     * Counts the sources handed to the engine, so an attach superseded while
     * the engine was taking its source can tell whether that source is still
     * the one the engine holds — whether anything has been handed over since.
     */
    private handovers = 0;
    private source: PlayerSource | null = null;
    private master: MasterInfo | null = null;
    /** Each subtitle track's lines, read once per master. */
    private subtitleCues = new Map<string, Promise<LyricCue[]>>();
    private cache = new Map<string, string>();
    /** What this source has served; see {@link ServeMemo}. */
    private served: ServeMemo = { playlists: new Map() };
    /**
     * The sidecar subtitles handed to the adapter for this source. An adapter
     * drops its text tracks with the source they belong to, on every
     * `loadSource`, so each attach after the first has to hand them back.
     */
    private sidecarTextTracks: AdapterTextTrack[] = [];
    /**
     * The audio track somebody chose through {@link setAudioTrack} — a host's
     * selector, a viewer's pick relayed from the engine's own menu, a
     * preferred-language rule. Null until somebody chooses; cleared by
     * `load()`, since a new source is a new decision.
     *
     * Kept apart from `activeAudioTrackId` because it has to outlive the
     * engine's track list. Every attach after the first — an angle switch, the
     * audio toggle, a re-munge — hands the engine a new source, so does an
     * adapter's own `reattach()`, and each rebuilds the list with the stream's
     * default selected in it.
     */
    private chosenAudioTrackId: string | null = null;
    /**
     * The choice has yet to reach the engine's current list: it was made while
     * the list did not carry it, or the list has been torn down since. Cleared
     * when a list carrying it arrives and it is handed back.
     */
    private audioChoicePending = false;
    /**
     * The audio language the picture last followed: the one the angle was
     * chosen for, at load or by the last language change {@link setAudioTrack}
     * acted on. The rule there fires on a CHANGE of language against this, not
     * on every call, because hosts re-apply the viewer's preferred language
     * through that same method after every load, on `loadeddata` and on every
     * track-list change; were each of those a trigger, a hand-picked angle
     * would be undone moments after it landed.
     *
     * Null when there is no language to follow. Kept across a reload of the
     * same video (see {@link followedAudioLangSeeded}).
     */
    private followedAudioLang: string | null = null;
    /**
     * Whether {@link followedAudioLang} has been seeded for the video loaded,
     * which `applyMaster` does once. Cleared by a `load()` of another video;
     * left alone by a reload of the same one.
     *
     * A flag rather than "seed while null", because null is a legitimate value
     * — the stream's audio names no language, the host named none it
     * has — and the master is only read in `applyMaster`, which may run long
     * after `load()` returns (the coming-soon poller). Seeding whenever it was
     * null would treat a same-video reload that was following nothing as a
     * fresh video, and seed it from the reload's `preferredAudioLanguages`
     * instead: the next language the host applies would then compare against
     * a language the picture never followed, and could move the angle the
     * viewer had kept. With the flag, a reload of the same video starts from
     * exactly what the picture followed before it.
     */
    private followedAudioLangSeeded = false;
    /**
     * The angle the picture would return to from Audio only when the load
     * began, kept for `applyMaster` on a reload of the same video: one that
     * starts as Audio only should come back to the angle the viewer was on,
     * not to the default. Null for another video.
     */
    private reloadVideoAngleId: string | null = null;
    private qualityToVariant = new Map<string, string>();
    /**
     * A quality chosen through {@link setQuality} on an engine that cannot pin
     * a rendition, which the munge applies as a height cap on every attach —
     * an angle switch and a recovery re-munge keep it. Null for `'auto'`, and
     * cleared by `load()`, since a new source is a new decision.
     */
    private qualityChoice: { id: string; height: number } | null = null;
    private startPosition = 0;
    private resumePlaying = false;
    private chapterTrackPinned = false;
    /** The in-place cap on the picture's height ({@link setMaxHeight}); null while there is none. */
    private liveCap: number | null = null;

    constructor(
        private readonly adapter: PlayerAdapter,
        private readonly options: PlayerControllerOptions,
    ) {
        this.fetchImpl =
            options.fetchImpl ??
            ((input: RequestInfo | URL, init?: RequestInit) =>
                globalThis.fetch(input, init));
        this.subtle = options.subtle;
        this.serveStrategy = options.serveStrategy;

        this.attachAdapter();
    }

    // -----------------------------------------------------------------------
    // Loading
    // -----------------------------------------------------------------------

    async load(source: PlayerSource): Promise<void> {
        if (this.state.lifecycle === 'destroyed') return;

        const generation = ++this.generation;
        // Read before `attaching` is cleared below: a reload asked for
        // mid-attach keeps the position that attach was carrying.
        const carried = source.preservePosition ? this.carriedPlayback() : null;
        const preserved = carried ? carried.seekTo : source.startPosition ?? 0;
        const resume = carried?.resume ?? false;

        this.teardownSource();
        this.attaching = null;
        this.sleep.onNewSource();
        // A new video starts under the cap its source asks for; the same one loaded again keeps the cap moved since.
        const sameVideo = this.source?.masterUrl === source.masterUrl;
        this.source = source;
        if (source.maxHeightInPlace && this.canCapInPlace && !sameVideo)
            this.liveCap = source.maxHeight ?? null;
        // The same video loaded again — a cap lifted, a reload with the
        // position kept — keeps following the language it followed, and the
        // picture it would return to from Audio only; another video decides
        // both afresh once its master is read. Read before the reset below;
        // a reload made before the last one had read its master (the state
        // names no angle yet) passes on what that one was carrying.
        this.reloadVideoAngleId = sameVideo
            ? this.state.videoAngleId ?? this.reloadVideoAngleId
            : null;
        if (!sameVideo) {
            this.followedAudioLang = null;
            this.followedAudioLangSeeded = false;
        }
        this.policy = resolveRecoveryPolicy(source.recovery);
        this.startPosition = preserved;
        this.resumePlaying = resume;
        this.chapterTrackPinned = false;
        this.chosenAudioTrackId = null;
        this.audioChoicePending = false;
        this.qualityChoice = null;
        this.cache = new Map();
        // `teardownSource` above released every URL the last source was
        // served at, so nothing it memoized can be handed out again.
        this.served = { playlists: new Map() };
        this.sidecarTextTracks = [];
        this.qualityToVariant = new Map();
        // Cleared here, not only when the next set arrives: a load that fails
        // before its sidecars would otherwise leave the previous video's frames
        // available to `thumbnailAt`.
        this.thumbnailCues = [];
        this.thumbnailStripUrl = undefined;

        this.store.reset({
            ...createInitialState(),
            lifecycle: 'loading',
            sleepTimer: this.sleep.state,
            playbackRate: this.state.playbackRate,
            maxHeight: source.maxHeight,
        });

        try {
            // Inside the try, not above it: a serving layer may throw on first
            // use — a native shell whose loopback server failed to bind, say.
            // Every host calls `load()` fire-and-forget, because the contract is
            // that failures surface through state; a throw here would escape as
            // an unhandled rejection instead of rendering the error panel.
            this.sidecarLoader = new SidecarLoader({
                fetchImpl: this.fetchImpl,
                serveStrategy: this.serveStrategy,
                keyHex: source.keyHex,
                subtle: this.subtle,
            });

            const info = await loadMaster(source.masterUrl, this.context());
            if (generation !== this.generation) return;
            await this.applyMaster(generation, info);
        } catch (error) {
            if (generation !== this.generation) return;
            if (isMissing(error) && (source.poll?.enabled ?? true)) {
                // The engine may still hold the PREVIOUS source (teardown
                // stops our plumbing, not the adapter). "Coming soon" over
                // silently continuing stale playback is a lie — stop it.
                this.releaseEngineSource();
                this.store.setState({
                    lifecycle: 'waiting-for-master',
                    playing: false,
                });
                this.startPolling(generation, source);
                return;
            }
            // A new source that never loaded: the engine still holds the previous one.
            this.releaseEngineSource();
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
        this.subtitleCues.clear();
        // Seeded from what the host is about to choose, never from the start
        // angle: the angle follows the audio, not the other way round, and a
        // host's `startAngleId` (the angle a reload is to keep, say) says
        // nothing about which language it will select next.
        if (!this.followedAudioLangSeeded) {
            this.followedAudioLang = startAudioLanguage(
                info,
                this.source?.preferredAudioLanguages,
            );
            this.followedAudioLangSeeded = true;
        }
        const requested = this.source?.startAngleId;
        // A plain picture for the language the audio starts in, so a viewer
        // who prefers French starts on the French titles instead of watching
        // the picture switch once the host selects the audio. A master whose
        // angles carry no language has no such angle, and starts on its
        // default as it always has.
        const forAudio = angleForAudio(
            info.angles,
            undefined,
            this.followedAudioLang,
        );
        const angleId =
            requested && info.angles.some((angle) => angle.id === requested)
                ? requested
                : forAudio ?? defaultAngleId(info.angles);
        const reloaded = this.reloadVideoAngleId;
        const videoAngleId =
            angleId !== AUDIO_ONLY_ANGLE_ID
                ? angleId
                : reloaded !== null &&
                  reloaded !== AUDIO_ONLY_ANGLE_ID &&
                  info.angles.some((angle) => angle.id === reloaded)
                ? reloaded
                : forAudio ?? defaultVideoAngleId(info.angles);

        this.store.setState({
            lifecycle: 'loading',
            bufferedEnd: 0,
            angles: info.angles,
            activeAngleId: angleId,
            videoAngleId,
            audioTracks: info.audioTracks,
            activeAudioTrackId: info.audioTracks[0]?.id ?? null,
            subtitleTracks: info.subtitleTracks,
            // A load starts with subtitles off on every engine; one left marked from the last video reads as on, and
            // a host waiting for "off" before applying the viewer's choice would never apply it.
            activeSubtitleTrackId: null,
            isAudioOnly: info.nativelyAudioOnly,
            chapterTracks: this.prepareChapterTracks(info),
        });

        await this.attachAngle(generation, angleId, {
            seekTo: this.startPosition,
            resume: this.resumePlaying,
        });
        if (generation !== this.generation) return;

        await this.attachSidecars(generation, info);
    }

    /**
     * Steps 3–6 of the pipeline, plus engine attach. Used by load/setAngle/reload.
     *
     * Resolves true when this attach landed: the engine was handed its source
     * and the state describes it. False when it did not — a new source
     * started, or another attach superseded it (see {@link attaching}; one
     * superseded after the engine took its source may still have been
     * described). A superseded attach swallows its own failure, since the one
     * replacing it decides what the viewer sees, and resolves only once that
     * one has finished, so whoever awaits it does not carry on before the
     * engine holds a source.
     *
     * `announce` marks an attach that carries an angle change somebody has yet
     * to be told of; an attach that supersedes it without changing the angle (a
     * re-munge, a quality cap) takes the duty over. See {@link announceAngle}.
     */
    private async attachAngle(
        generation: number,
        angleId: string | null,
        options: {
            seekTo: number;
            resume: boolean;
            fromEngine?: boolean;
            announce?: boolean;
        },
    ): Promise<boolean> {
        const info = this.master;
        if (!info) return false;

        let finished!: () => void;
        const attach: InFlightAttach = {
            angleId,
            seekTo: options.seekTo,
            resume: options.resume,
            placed: false,
            fromEngine: options.fromEngine ?? false,
            readAt: this.handovers,
            announce: options.announce ?? false,
            done: new Promise<void>((resolve) => (finished = resolve)),
        };
        this.attaching = attach;
        try {
            return await this.performAttach(generation, info, attach);
        } catch (error) {
            if (generation !== this.generation || this.attaching === attach)
                throw error;
            return await this.yieldToReplacement();
        } finally {
            if (this.attaching === attach) this.attaching = null;
            finished();
        }
    }

    /**
     * Waits for the attach that superseded the caller's, and for any that
     * superseded that one in turn: each one's `done` settles only after those
     * replacing it have.
     */
    private async yieldToReplacement(): Promise<false> {
        await this.attaching?.done;
        return false;
    }

    private async performAttach(
        generation: number,
        info: MasterInfo,
        attach: InFlightAttach,
    ): Promise<boolean> {
        const { angleId } = attach;
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
                  {
                      angleId,
                      // Held in place, the cap is the engine's: the ladder goes whole.
                      maxHeight:
                          this.source?.maxHeightInPlace && this.canCapInPlace
                              ? undefined
                              : this.source?.maxHeight,
                      selectHeight: this.qualityChoice?.height,
                  },
                  this.context(),
              );
        if (generation !== this.generation) return false;
        // Superseded while munging: the engine never hears of this one.
        if (this.attaching !== attach) return this.yieldToReplacement();
        // Read off the engine when it began, and nothing handed over since:
        // the engine has played on the source it played then while the
        // playlists were fetched, so a seek or a pause the viewer made
        // meanwhile is on the engine, not on the record, and the seconds
        // played are not played again — the rule `carriedPlayback` applies to
        // an attach started over this one. A load's first attach is never read
        // off the engine: a new video still starts where it was asked to.
        if (attach.fromEngine && attach.readAt === this.handovers) {
            attach.seekTo = this.adapter.getCurrentTime();
            attach.resume = this.state.playing;
        }
        const { seekTo, resume } = attach;

        // The policy is completed here rather than in the pipeline: it is the
        // controller that resolves a source's overrides, and the adapter that
        // runs the ladder on the result.
        const dataSaver = this.source?.dataSaver === true;
        const measured = this.source?.bandwidthEstimate;
        const usable =
            measured && measured > 0 && Number.isFinite(measured)
                ? measured
                : undefined;
        // A data saver starts low whatever the host measured: the estimate is the one input both
        // engines already start from, so clamping it here needs no engine to know about data savers.
        const bandwidth = dataSaver
            ? Math.min(usable ?? Infinity, DATA_SAVER_START_BPS)
            : usable;
        // An in-place cap outlives the load; the engine is told it again for what it now holds.
        if (this.liveCap !== null) this.adapter.setMaxHeight?.(this.liveCap);
        const handover = ++this.handovers;
        await this.adapter.loadSource({
            ...(source ?? munged!.source),
            ...(bandwidth !== undefined
                ? { bandwidthEstimate: bandwidth }
                : {}),
            ...(dataSaver ? { dataSaver } : {}),
            recovery: this.policy,
        });
        if (generation !== this.generation) return false;
        // Superseded while the engine took the source, and a later source has
        // gone in since: the state is left to describe that one. Superseded
        // with nothing handed over since, this source is what the engine holds
        // until the replacement hands over its own — which it may never do (its
        // munge can fail) — so it is described and placed below, and only then
        // does it step aside.
        if (this.attaching !== attach && handover !== this.handovers)
            return this.yieldToReplacement();

        // A subtitle chosen while this source was being prepared reached the
        // engine before the source did, and an engine starts a source with
        // subtitles off: it is told the choice again now that it has it.
        const subtitle = this.state.activeSubtitleTrackId;
        if (subtitle !== null) this.setSubtitleTrack(subtitle);

        // The adapter dropped the sidecar subtitles with the source it just
        // replaced. Empty on a first attach: they are loaded after it.
        if (this.sidecarTextTracks.length > 0) {
            this.adapter.setTextTracks(this.sidecarTextTracks);
        }

        // The narrowed master references only this angle's renditions plus the
        // audio group, so the schedules built from it are exactly the chains
        // playback is about to pull — an angle switch comes back through here
        // and rebuilds them.
        this.updateChunkWarming(munged);

        this.store.setState({
            lifecycle: 'ready',
            activeAngleId: angleId,
            activeQualityId: this.qualityChoice?.id ?? 'auto',
            qualities: (munged?.qualities ?? []).filter(
                (quality) =>
                    this.liveCap === null ||
                    (quality.height ?? 0) <= this.liveCap,
            ),
            isAudioOnly:
                munged?.isAudioOnly ??
                (info.nativelyAudioOnly || angleId === AUDIO_ONLY_ANGLE_ID),
            live: munged?.isLive ?? false,
            error: null,
        });
        this.refreshQualities();
        this.refreshAudioTracks();

        // Each load of a live source starts a new timeline, so a carried-over position lands at or past
        // the new live edge and playback waits for segments not yet published; the engine's own live start is right.
        if (seekTo > 0 && !munged?.isLive) this.adapter.seek(seekTo);
        attach.placed = true;
        // Superseded, but the engine holds this source until the one replacing
        // it hands over its own: it is described and put where it was, in case
        // that one never lands. It neither plays nor announces.
        if (this.attaching !== attach) return this.yieldToReplacement();
        if (resume) {
            await this.adapter.play().catch(() => undefined);
            if (generation !== this.generation) return false;
            // Superseded while it was starting to play (a new source aborts the
            // play under way): it reached the engine, but the one replacing it
            // reports for both, so announcements end on the angle that stays.
            if (this.attaching !== attach) return this.yieldToReplacement();
        }
        return true;
    }

    private async attachSidecars(
        generation: number,
        info: MasterInfo,
    ): Promise<void> {
        const loader = this.sidecarLoader;
        if (!loader) return;

        // An engine that cannot render side-loaded text gets none: the files
        // are not fetched, and the tracks are not offered. Subtitles the master
        // carries are the engine's own, and stay.
        if (this.adapter.capabilities.renderText) {
            try {
                const { tracks, adapterTracks } =
                    await loader.loadSubtitleTracks(
                        this.source?.sidecars?.subtitles,
                    );
                if (generation !== this.generation) return;
                if (adapterTracks.length > 0) {
                    this.sidecarTextTracks = adapterTracks;
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
        }

        if (generation !== this.generation) return;
        this.selectDefaultChapterTrack(generation);

        if (generation !== this.generation) return;
        await this.attachThumbnails(generation);
    }

    /**
     * Fetch and parse the scrub-preview sidecar, if there is one.
     *
     * Deliberately last of the sidecars and deliberately silent: a preview is
     * the least of what a viewer came for, and every way it can be absent — no
     * sidecar, an audio-only encode, `thumbnails: false`, a 404 — is normal
     * rather than an error worth surfacing. `loadThumbnails` already collapses
     * those to an empty list.
     *
     * Asked again on every angle switch, because a master can name a strip per
     * angle. One strip for every angle is the common case, and then a switch
     * resolves to the URL already shown and reads nothing — unless reading it
     * gave no frames, which the next switch tries again.
     */
    private async attachThumbnails(generation: number): Promise<void> {
        const url = this.thumbnailStripFor(this.state.activeAngleId);
        if (url === this.thumbnailStripUrl) return;
        this.thumbnailStripUrl = url;
        // The last angle's frames would preview the wrong picture: none until
        // this angle's strip is in.
        if (this.thumbnailCues.length > 0) {
            this.thumbnailCues = [];
            this.updateThumbnailsReady();
        }
        const cues =
            (await this.sidecarLoader?.loadThumbnails(
                url ? { url } : undefined,
            )) ?? [];
        if (generation !== this.generation || this.thumbnailStripUrl !== url)
            return;
        if (cues.length === 0) this.thumbnailStripUrl = undefined;
        this.thumbnailCues = cues;
        this.updateThumbnailsReady();
    }

    /**
     * The strip to show on `angleId`: the one the master names for it, else
     * the host's. The host's is the fixed name, which a regeneration no longer
     * rewrites, so it only stands in for a master that names no strip at all.
     */
    private thumbnailStripFor(angleId: string | null): string | undefined {
        const declared = this.master?.thumbnails ?? [];
        if (declared.length === 0) return this.source?.sidecars?.thumbnails?.url;
        return resolveThumbnails(declared, angleId)?.uri;
    }

    /** Ready once there are cues that span the video; re-asked when the duration becomes known. */
    private updateThumbnailsReady(): void {
        this.store.setState({
            thumbnailsReady: thumbnailsCoverDuration(
                this.thumbnailCues,
                this.state.duration,
            ),
        });
    }

    /**
     * The sprite frame to show for `timeSec`, or null when there is none.
     *
     * A lookup rather than state, because a scrub asks per pointer move and the
     * answer is not something the rest of the UI reacts to — putting it in the
     * store would publish a change to every subscriber on every mouse move.
     */
    thumbnailAt(timeSec: number): ThumbnailSpriteCue | null {
        if (this.thumbnailCues.length === 0) return null;
        const cue = findThumbnailCue(this.thumbnailCues, timeSec);
        if (!cue) return null;
        // A frame is sampled at its cue's start, so the second half of a cue is nearer the next frame than its own.
        const span = cue.endTime - cue.startTime;
        const next =
            span > 0
                ? findThumbnailCue(this.thumbnailCues, cue.endTime)
                : undefined;
        return next && timeSec - cue.startTime > span / 2 ? next : cue;
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

    setSleepTimer(option: SleepTimerOption | null): void {
        if (this.state.lifecycle === 'destroyed') return;
        let chapterEnd: number | undefined;
        if (option?.kind === 'chapter') {
            const { chapters, currentTime, duration } = this.state;
            const index = chapterIndexAt(chapters, currentTime);
            if (index < 0) return;
            chapterEnd =
                chapters[index + 1]?.startTime ??
                (Number.isFinite(duration) && duration > 0
                    ? duration
                    : undefined);
        }
        this.sleep.set(option, chapterEnd);
        // A shell may keep the minutes timer beside the engine, where a suspended web view cannot stop it.
        this.adapter.setSleepTimer?.(
            this.sleep.state?.kind === 'minutes'
                ? this.sleep.state.endsAt
                : null,
        );
    }

    setPlaybackRate(rate: number): void {
        this.adapter.setPlaybackRate(rate);
        this.store.setState({ playbackRate: rate });
    }

    async setAngle(id: string): Promise<void> {
        if (!this.master || this.state.lifecycle === 'destroyed') return;
        if (!this.state.angles.some((angle) => angle.id === id)) return;
        // At request time, not when the attach lands: a language change made
        // while this switch is under way follows the audio from the angle the
        // viewer asked for. Audio only leaves it alone — it is the angle that
        // choosing Audio only comes back from.
        if (id !== AUDIO_ONLY_ANGLE_ID)
            this.store.setState({ videoAngleId: id });
        // Against the angle on its way in: the one last attached is stale while
        // another attaches. Asking for that one again is not a cancel; it is
        // attached again, over the one in flight.
        if (id === this.targetAngleId) return;

        const generation = this.generation;
        let landed: boolean;
        try {
            landed = await this.attachAngle(generation, id, {
                ...this.carriedPlayback(),
                announce: true,
            });
        } catch (error) {
            if (generation !== this.generation) return;
            // The switch never landed: the angle playing is still the one the
            // state names, and it is the one a later language change, a reload
            // or "Video" starts from — not an angle that never played. Asked
            // for from Audio only, the angle stays: it is still the one
            // "Video" goes back to.
            const playing = this.state.activeAngleId;
            if (
                this.state.videoAngleId === id &&
                playing !== null &&
                playing !== AUDIO_ONLY_ANGLE_ID
            ) {
                this.store.setState({ videoAngleId: playing });
            }
            this.fail(toPlayerError(error));
            return;
        }
        if (!landed || generation !== this.generation) return;
        this.announceAngle(generation, id);
    }

    /**
     * Tells hosts the angle changed, once the attach carrying the change has
     * landed, and reads that angle's scrub strip. Only a landed attach
     * announces, so a burst of switches announces the last one alone.
     */
    private announceAngle(generation: number, angleId: string): void {
        this.emitter.emit('angle-changed', { angleId });
        // Not awaited: the switch is done once the engine has the angle, and a
        // scrub preview arriving a moment later is all a slow strip costs.
        void this.attachThumbnails(generation);
    }

    /**
     * The angle the engine is being given, else the one it has. An attach in
     * flight is what the next attach builds on: re-munging or re-capping the
     * angle last landed would undo a switch still under way.
     */
    private get targetAngleId(): string | null {
        return this.attaching
            ? this.attaching.angleId
            : this.state.activeAngleId;
    }

    /**
     * Where a new attach picks up from, and whether that was read off the
     * engine (see `InFlightAttach.fromEngine`).
     *
     * With nothing in flight, the engine's own clock and play state are the
     * truth. They still are while the attach in flight was itself started from
     * them and has handed nothing over since: the engine plays on the source
     * it played then, and a seek or a pause the viewer made while that attach
     * fetched its playlists is on the engine, not on the record. A switch made
     * over a switch keeps it.
     *
     * Otherwise the engine holds a source it has not loaded yet, or the one a
     * load is replacing (a load's first attach), so its position and play
     * state describe nothing; the attach in flight carries what it was
     * handed. Once that attach has put the engine at its position (`placed`),
     * the engine's clock counts again: the record lives on until `play()`
     * settles, and a seek the viewer made while the new source buffered would
     * otherwise be undone by the next attach. Whether it plays on still comes
     * from the record, since the play it asked for has not started yet.
     */
    private carriedPlayback(): {
        seekTo: number;
        resume: boolean;
        fromEngine: boolean;
    } {
        const inFlight = this.attaching;
        if (
            !inFlight ||
            (inFlight.fromEngine && inFlight.readAt === this.handovers)
        ) {
            return {
                seekTo: this.adapter.getCurrentTime(),
                resume: this.state.playing,
                fromEngine: true,
            };
        }
        return {
            seekTo: inFlight.placed
                ? this.adapter.getCurrentTime()
                : inFlight.seekTo,
            resume: inFlight.resume,
            fromEngine: false,
        };
    }

    get canCapInPlace(): boolean {
        return (
            this.adapter.capabilities.liveMaxHeight === true &&
            !!this.adapter.setMaxHeight
        );
    }

    setMaxHeight(height: number | null): boolean {
        if (!this.canCapInPlace || this.state.lifecycle === 'destroyed')
            return false;
        const cap = height && height > 0 ? height : null;
        this.liveCap = cap;
        this.adapter.setMaxHeight!(cap);
        this.store.setState({
            maxHeight:
                cap ??
                (this.source?.maxHeightInPlace
                    ? undefined
                    : this.source?.maxHeight),
        });
        this.refreshQualities(true);
        const held = this.state.qualities.find(
            (q) => q.id === this.state.activeQualityId,
        );
        // A hand pick stands across the cap's changes; only one the cap has put out of reach goes back to Auto. Lifted,
        // Auto is free to climb on its own.
        if (this.state.activeQualityId !== 'auto' && !held)
            this.setQuality('auto');
        return true;
    }

    setQuality(id: string | 'auto'): void {
        if (!this.adapter.capabilities.variantSwitching) {
            void this.capQuality(id);
            return;
        }
        const variantId =
            id === 'auto' ? 'auto' : this.qualityToVariant.get(id) ?? id;
        this.adapter.setVariant(variantId);
        this.store.setState({ activeQualityId: id });
    }

    /**
     * A quality choice for an engine that cannot pin a rendition (AVPlayer):
     * re-munge the current angle (or the one on its way in) with the chosen
     * height as a cap, keeping position and play state, so the engine's own
     * ABR stays at or below it.
     * `'auto'` lifts the cap back to the source's own `maxHeight`.
     *
     * A resolution-less quality has no height to cap at, so choosing one does
     * nothing.
     */
    private async capQuality(id: string | 'auto'): Promise<void> {
        if (!this.master || this.state.lifecycle === 'destroyed') return;
        let choice: { id: string; height: number } | null = null;
        if (id !== 'auto') {
            const height = this.state.qualities.find(
                (q) => q.id === id,
            )?.height;
            if (height === undefined) return;
            choice = { id, height };
        }
        if (choice?.height === this.qualityChoice?.height) return;

        this.qualityChoice = choice;
        this.store.setState({ activeQualityId: id });

        await this.reattachSelection(this.generation);
    }

    /**
     * Attaches again what is on its way to the engine, else what it has: a
     * re-munge and a quality cap rebuild the selection, they do not change it.
     * An angle switch they supersede becomes theirs to announce once they land.
     *
     * Resolves whether this attach landed. A failure is terminal, as it is for
     * any attach, and resolves false.
     */
    private async reattachSelection(generation: number): Promise<boolean> {
        const angleId = this.targetAngleId;
        const announce = this.attaching?.announce ?? false;
        let landed: boolean;
        try {
            landed = await this.attachAngle(generation, angleId, {
                ...this.carriedPlayback(),
                announce,
            });
        } catch (error) {
            if (generation === this.generation) this.fail(toPlayerError(error));
            return false;
        }
        if (!landed || generation !== this.generation) return false;
        if (announce && angleId !== null) this.announceAngle(generation, angleId);
        return true;
    }

    /**
     * Selects an audio track, and moves the picture to the angle for its
     * language when the language changed (see `PlayerControllerApi`).
     *
     * Why each condition of the rule holds:
     *
     * - It lives here, in the public method, and nowhere else. The hand-back
     *   after a re-attach ({@link handBackAudioChoice}) calls the adapter
     *   directly, so it cannot start a switch. Neither can an engine
     *   re-selecting its own default while it rebuilds its list — unless a
     *   host relays that here: a host that mirrors the engine's selections
     *   into this method (a menu relay) would read the rebuilt list's default
     *   as a pick, and a default in another language WOULD start a switch.
     *   Such a host must not relay the first selection on a new list.
     * - It fires on a CHANGE of language against {@link followedAudioLang},
     *   never on a repeat. Hosts re-apply the preferred language through this
     *   method after every load, on `loadeddata` and on every track-list
     *   change; a repeat is that, not a viewer's decision, and is what lets an
     *   angle picked by hand hold until the audio language next changes.
     * - The language is read from `state.audioTracks`, which holds the
     *   master-derived list until the engine's arrives and is not emptied
     *   when the engine's is torn down for a re-attach, so it answers for
     *   whichever kind of id the host is selecting by.
     * - Whether to re-attach is decided against the angle on its way in
     *   ({@link targetAngleId}) — the test `setAngle` itself applies — not
     *   against {@link PlayerState.videoAngleId}, which moves when a switch
     *   is asked for rather than when it lands, and is not what `setAngle`
     *   tests. Were the two to disagree, a choice could be left pending for a
     *   switch `setAngle` then declines as already under way, and no engine
     *   would ever be told of it. When the target is on its way already, that
     *   attach hands the choice back on arrival.
     * - While Audio only plays, only `videoAngleId` moves: no video is
     *   fetched, and "Video" returns to the angle for the language chosen.
     * - A `nativeHls` adapter is handed the whole master, and picks the
     *   picture itself; there is nothing here to switch.
     *
     * A switch is ONE interruption: the track is not selected on the outgoing
     * engine — it is about to be replaced — and the choice is left pending, so
     * {@link refreshAudioTracks} hands it to the new engine's list. (A
     * track-list change on the outgoing engine while the new angle is fetched
     * hands it the choice early, which is harmless: the new list is handed it
     * all the same.)
     */
    setAudioTrack(id: string): void {
        const lang = this.state.audioTracks.find((t) => t.id === id)?.lang;
        let target: string | undefined;
        if (
            lang &&
            this.master &&
            !this.adapter.capabilities.nativeHls &&
            !matchesPreferredLanguage(lang, this.followedAudioLang)
        ) {
            this.followedAudioLang = lang;
            target = angleForAudio(
                this.state.angles,
                this.angleOf(this.state.videoAngleId),
                lang,
            );
        }
        const reattach =
            target !== undefined &&
            this.targetAngleId !== AUDIO_ONLY_ANGLE_ID &&
            target !== this.targetAngleId;

        this.chosenAudioTrackId = id;
        // A list that does not carry it yet — the engine's has not arrived, or
        // is being rebuilt — gets it handed over once it does; so does the
        // list of the engine an angle switch is about to bring in.
        const listed = this.adapter
            .getAudioTracks()
            .some((track) => track.id === id);
        this.audioChoicePending = reattach || !listed;
        if (!reattach) this.adapter.setAudioTrack(id);
        this.store.setState({
            activeAudioTrackId: id,
            ...(target !== undefined ? { videoAngleId: target } : {}),
        });
        if (!this.chapterTrackPinned) {
            this.selectDefaultChapterTrack(this.generation);
        }
        // Last, once the choice is recorded: the attach reads it when the new
        // engine lists its tracks.
        if (reattach) void this.setAngle(target!);
    }

    /** The angle of the master with this id, if any. */
    private angleOf(id: string | null): Angle | undefined {
        return id === null
            ? undefined
            : this.state.angles.find((angle) => angle.id === id);
    }

    setSubtitleTrack(id: string | null): void {
        const track =
            id === null
                ? undefined
                : this.state.subtitleTracks.find((t) => t.id === id);
        this.adapter.setActiveTextTrack(
            id,
            track
                ? {
                      label: track.label,
                      ...(track.lang ? { lang: track.lang } : {}),
                  }
                : undefined,
        );
        this.store.setState({ activeSubtitleTrackId: id });
    }

    readSubtitleCues(id: string): Promise<LyricCue[]> {
        const master = this.master;
        if (!master) return Promise.resolve([]);
        const cached = this.subtitleCues.get(id);
        if (cached) return cached;
        const read = readSubtitleCues(master, id, {
            fetchImpl: this.fetchImpl,
            keyHex: this.source?.keyHex,
            subtle: this.subtle,
        }).catch(() => {
            // A failed read is tried again the next time it is asked for.
            if (this.subtitleCues.get(id) === read)
                this.subtitleCues.delete(id);
            return [];
        });
        this.subtitleCues.set(id, read);
        return read;
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
        this.attaching = null;
        this.sleep.clear();
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

    private context(): PipelineContext {
        return {
            fetchImpl: this.fetchImpl,
            serveStrategy: this.serveStrategy,
            keyDelivery: this.adapter.capabilities.keyDelivery,
            keyHex: this.source?.keyHex,
            subtle: this.subtle,
            cache: this.cache,
            served: this.served,
        };
    }

    /**
     * Hand the adapter the chunk chains the munge just attached will pull,
     * replacing whatever it was warming before. A native-HLS load has no munged
     * playlists to read, a source without byte ranges yields no schedules, and
     * warming can be switched off outright — all three arrive as an empty
     * array, which the contract defines as "stop", so the call is unconditional
     * and there is one path for both arming and stopping.
     *
     * Every tuning value is resolved here: the adapter is handed decisions, not
     * a partially filled options bag it would have to know the defaults for.
     */
    private updateChunkWarming(munged: MungeResult | null): void {
        const settings = this.options.prefetch;
        const options: ChunkWarmOptions = {
            leadSeconds: settings?.leadSeconds ?? DEFAULT_LEAD_SECONDS,
            warmBytes: settings?.warmBytes ?? DEFAULT_WARM_BYTES,
            fetchImpl: this.fetchImpl,
            ...(settings?.debug
                ? {
                      log: (message: string) =>
                          console.info(`[luminary-prefetch] ${message}`),
                  }
                : {}),
        };

        const schedules =
            settings?.enabled === false || !munged
                ? []
                : buildChunkSchedules(munged.mediaPlaylists);

        this.adapter.warmChunks?.(schedules, options);
    }

    /** Release the previous generation's resources. */
    private teardownSource(): void {
        this.poller?.stop();
        this.poller = null;
        this.updateChunkWarming(null);
        this.serveStrategy.release();
        this.master = null;
        this.subtitleCues.clear();
    }

    /**
     * The chapter files the master names win over the host's, language by
     * language. Each chapter save writes a new name and records it in the
     * master, so a host-built `chapters/<lang>.vtt` is the legacy copy — kept
     * for every language the master does not name, which on a video from
     * before the index is each one not saved since. The host still knows what
     * to call a language, so its label carries over to the master's file.
     */
    private prepareChapterTracks(info: MasterInfo) {
        const hosted = this.source?.sidecars?.chapters ?? [];
        const declared = info.chapters ?? [];
        const named = new Set(declared.map((sidecar) => sidecar.lang));
        this.sidecarLoader?.setChapters(
            hosted
                .map((entry) => {
                    if (!named.has(entry.lang)) return entry;
                    const sidecar = declared.find(
                        (d) => d.lang === entry.lang,
                    )!;
                    return entry.label === undefined
                        ? sidecar
                        : { ...sidecar, label: entry.label };
                })
                .concat(
                    declared.filter(
                        (sidecar) =>
                            !hosted.some(
                                (entry) => entry.lang === sidecar.lang,
                            ),
                    ),
                ),
        );
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
    private refreshQualities(force = false): void {
        const variants = this.adapter.getVariants();
        if (variants.length === 0) return;

        const map = new Map<string, string>();
        const qualities: Quality[] = [];
        const cap = this.liveCap;
        for (const variant of variants) {
            // Above an in-place cap a rendition is not offered: ABR cannot reach it either.
            if (cap !== null && (variant.height ?? 0) > cap) continue;
            // The engine reports no width, so the playlist's own is kept.
            const known = this.state.qualities.find(
                (q) => q.height === variant.height,
            );
            const quality = toQuality(
                variant.height,
                variant.bandwidth,
                known?.width,
            );
            if (!map.has(quality.id)) qualities.push(quality);
            map.set(quality.id, variant.id);
        }
        this.qualityToVariant = map;

        const sorted = sortQualities(qualities);
        if (!force && sameIds(sorted, this.state.qualities)) return;
        this.store.setState({ qualities: sorted });
    }

    private refreshAudioTracks(): void {
        const tracks = this.adapter.getAudioTracks();
        if (tracks.length === 0) {
            // The engine tore its list down, and the one it builds next has
            // its own default selected. See `PlayerAdapter.getAudioTracks`.
            if (this.chosenAudioTrackId !== null)
                this.audioChoicePending = true;
            return;
        }

        const mapped = dedupeByName(
            tracks.map((track) => ({
                id: track.id,
                lang: track.lang,
                label: track.label,
            })),
        );
        const chosen = this.chosenAudioTrackId;
        const chosenListed =
            chosen !== null && mapped.some((track) => track.id === chosen);
        if (this.audioChoicePending && chosenListed) {
            this.audioChoicePending = false;
            this.handBackAudioChoice(chosen);
        }
        if (sameIds(mapped, this.state.audioTracks)) return;

        const active = chosenListed
            ? chosen
            : mapped.some((track) => track.id === this.state.activeAudioTrackId)
            ? this.state.activeAudioTrackId
            : mapped[0]?.id ?? null;
        this.store.setState({
            audioTracks: mapped,
            activeAudioTrackId: active,
        });
    }

    /**
     * Selects the chosen track again in a list the engine has just rebuilt.
     *
     * A microtask late rather than now, because this runs while the engine is
     * still announcing its tracks: video.js announces each one before it starts
     * listening to it, so a track enabled from inside the announcement is
     * enabled without the list — or VHS — ever hearing of it, and the default
     * plays on with both marked enabled. By the next microtask the list is
     * whole and listening.
     */
    private handBackAudioChoice(id: string): void {
        const generation = this.generation;
        void Promise.resolve().then(() => {
            if (generation !== this.generation) return;
            // A newer choice selected itself. A list torn down again in the
            // meantime is pending again, and its rebuild hands this back.
            if (this.chosenAudioTrackId !== id) return;
            if (
                !this.adapter.getAudioTracks().some((track) => track.id === id)
            ) {
                return;
            }
            this.adapter.setAudioTrack(id);
        });
    }

    private attachAdapter(): void {
        this.adapterSubscriptions.push(
            this.adapter.on('timeupdate', ({ currentTime }) => {
                this.store.setState({ currentTime });
                this.sleep.onTime(currentTime);
            }),
            this.adapter.on('durationchange', ({ duration }) => {
                this.store.setState({ duration });
                this.updateThumbnailsReady();
            }),
            this.adapter.on('progress', ({ bufferedEnd }) => {
                this.store.setState({ bufferedEnd });
            }),
            this.adapter.on('playing', () => {
                // Playing is proof the engine is working: after an error, it got there by itself (its
                // own recovery, a retry), and an error panel left over it would misstate that.
                const recovered = this.state.lifecycle === 'error';
                this.store.setState({
                    playing: true,
                    ended: false,
                    stalled: false,
                    ...(recovered
                        ? { lifecycle: 'ready' as const, error: null }
                        : {}),
                });
                // A switch that failed left the audio choice it carried
                // pending, for a list that never arrived: the engine that
                // stayed is handed it now that it plays on.
                if (recovered && this.audioChoicePending)
                    this.refreshAudioTracks();
            }),
            this.adapter.on('pause', () => {
                this.store.setState({ playing: false, stalled: false });
            }),
            this.adapter.on('ended', () => {
                this.store.setState({
                    playing: false,
                    ended: true,
                    stalled: false,
                });
            }),
            // 'waiting' is normal buffering. Whether it has gone on long enough
            // to count as a stall is the engine's call, made against its own
            // buffer and delivered as 'stalled'; the wrapper only publishes it.
            this.adapter.on('stalled', ({ stalled }) => {
                this.store.setState({ stalled });
            }),
            this.adapter.on('seeked', () => {
                this.store.setState({
                    currentTime: this.adapter.getCurrentTime(),
                });
            }),
            // By contract an adapter has already spent its recovery obligation
            // before raising a fatal error — its engine's own primitive, bounded
            // re-attaches, and any re-munge it asked for below. There is nothing
            // left for the wrapper to try, so this is the end of the road.
            this.adapter.on('error', (payload) => {
                if (!payload.fatal) return;
                this.fail(adapterErrorToPlayerError(payload));
            }),
            // The one recovery step an engine cannot perform for itself.
            this.adapter.on('reload-requested', ({ attempt }) => {
                void this.remunge(attempt);
            }),
            this.adapter.on('variants-updated', () => this.refreshQualities()),
            this.adapter.on('audiotracks-updated', () =>
                this.refreshAudioTracks(),
            ),
        );
    }

    /**
     * Rebuild and re-attach the current selection, at an adapter's request.
     *
     * The same angle and the same cap: this is not a change of source but a
     * rebuild of it, for the failures re-attaching could not fix. A throw here
     * is terminal — the adapter asked for the last thing anyone could do.
     */
    private async remunge(attempt: number): Promise<void> {
        if (this.state.lifecycle === 'destroyed') return;
        // Superseded, it reports nothing: the attach that replaced it handed
        // the engine a freshly munged source of its own.
        if (!(await this.reattachSelection(this.generation))) return;
        this.emitter.emit('recovered', { attempt });
    }

    private fail(error: PlayerError): void {
        // Same reasoning as the waiting-for-master path: the adapter may
        // still be playing a previous source; an error surface over live
        // playback misstates both. Paused, not unloaded: mid-playback the
        // source and position are what a retry or the engine's own recovery resumes.
        this.adapter.pause();
        this.store.setState({ lifecycle: 'error', error, playing: false });
        this.emitter.emit('error', error);
    }

    /** Pausing alone leaves the previous source one press of play away. */
    private releaseEngineSource(): void {
        this.adapter.pause();
        this.adapter.unload?.();
        // The old source played on while the new one was fetched, and its position reached the state after the reset.
        this.store.setState({ currentTime: 0, duration: 0, bufferedEnd: 0 });
    }

    private emitNonFatal(error: PlayerError): void {
        this.emitter.emit('error', { ...error, fatal: false });
    }
}

/**
 * An exhausted adapter's error, as something a viewer can be shown. The
 * category is the engine's account of what went wrong; the message says the
 * recovery everyone agreed to try has been tried.
 */
function adapterErrorToPlayerError(payload: AdapterErrorPayload): PlayerError {
    const code: PlayerError['code'] =
        payload.category === 'network'
            ? 'network'
            : payload.category === 'media'
            ? 'media'
            : 'unknown';
    return {
        code,
        fatal: true,
        message: `Playback failed: unrecoverable ${payload.category} error`,
        cause: payload.detail,
    };
}

function defaultAngleId(angles: Angle[]): string | null {
    if (angles.length === 0) return null;
    const preferred =
        angles.find((angle) => angle.isDefault) ??
        angles.find((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID) ??
        angles[0];
    return preferred?.id ?? DEFAULT_ANGLE_ID;
}

/**
 * The camera angle the master would start on if Audio only were not an
 * option: the one Audio only returns to when nothing better is known. Null
 * when the master has no video.
 */
function defaultVideoAngleId(angles: Angle[]): string | null {
    const video = angles.filter((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID);
    return (video.find((angle) => angle.isDefault) ?? video[0])?.id ?? null;
}

/**
 * The language a load's audio will start in, as far as the controller can
 * tell before the host selects it: the first of the host's preferences the
 * master has audio for — the host's own rule picks by the same list and the
 * same matching — else the stream's default audio, which is what the engine
 * plays when nobody chooses. Not simply the first track: a master may list
 * French first and mark English the default, and the picture would then
 * start in French under English audio.
 */
function startAudioLanguage(
    info: MasterInfo,
    preferred: readonly string[] | undefined,
): string | null {
    for (const lang of preferred ?? []) {
        if (findPreferredTrack(info.audioTracks, lang) !== null) return lang;
    }
    return info.defaultAudioLang ?? info.audioTracks[0]?.lang ?? null;
}

function sameIds(a: { id: string }[], b: readonly { id: string }[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((item, index) => item.id === b[index]?.id);
}
