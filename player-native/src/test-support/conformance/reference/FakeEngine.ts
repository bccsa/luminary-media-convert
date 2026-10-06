/**
 * The reference `FakeEngine`: the behaviour `conformance/README.md` gives it,
 * which the Kotlin and Swift fakes must match. A command only records itself;
 * nothing changes until a signal says so.
 */

import type { InlineFrame } from '../../../bridge.js';
import type { Json, JsonObject } from '../scenario.js';
import type { VirtualClock } from './clock.js';

/** What the engine tells its `PlayerHost`, one method per signal. */
export interface EngineListener {
    readyToPlay(duration: number | null): void;
    playing(): void;
    paused(): void;
    buffering(): void;
    seeked(): void;
    ended(): void;
    tracks(tracks: Json, activeId: Json): void;
    variants(variants: Json): void;
    bufferedTo(end: number): void;
    rateChanged(rate: number): void;
    mutedChanged(muted: boolean): void;
}

export interface EngineSnapshot {
    currentTime: number;
    duration: number | null;
    bufferedEnd: number;
    playing: boolean;
}

export class FakeEngine {
    listener: EngineListener | null = null;
    hasVideo = true;
    private basePosition = 0;
    private baseTime = 0;
    private rate = 1;
    private isPlaying = false;
    private duration: number | null = 0;
    private bufferedEnd = 0;

    /** `log` is shared by every engine a harness creates: the harness drains one list. */
    constructor(
        private readonly clock: VirtualClock,
        private readonly log: JsonObject[],
    ) {}

    // Commands: recorded, never acted on.

    load(masterUri: string, startPosition: number | undefined): void {
        this.record({ method: 'load', masterUri, ...(startPosition === undefined ? {} : { startPosition }) });
        this.isPlaying = false;
        this.setPosition(startPosition ?? 0);
        this.duration = 0;
        this.bufferedEnd = 0;
        this.hasVideo = true;
    }

    reattach(): void {
        this.record({ method: 'reattach' });
    }
    play(): void {
        this.record({ method: 'play' });
    }
    pause(): void {
        this.record({ method: 'pause' });
    }
    seek(position: number, exact: boolean): void {
        this.record({ method: 'seek', position, exact });
    }
    setRate(rate: number): void {
        this.record({ method: 'setRate', rate });
    }
    setVariant(id: string): void {
        this.record({ method: 'setVariant', id });
    }
    setAudioTrack(id: string): void {
        this.record({ method: 'setAudioTrack', id });
    }
    setMuted(muted: boolean): void {
        this.record({ method: 'setMuted', muted });
    }
    setSubtitleTrack(label: string | null): void {
        this.record(label === null ? { method: 'setSubtitleTrack' } : { method: 'setSubtitleTrack', label });
    }
    startPictureInPicture(): void {
        this.record({ method: 'startPictureInPicture' });
    }
    setInlineFrame(frame: InlineFrame | null): void {
        this.record(frame ? { method: 'setInlineFrame', ...frame } : { method: 'setInlineFrame' });
    }
    enterFullscreen(texts: Record<string, string> | null = null): void {
        this.record(texts ? { method: 'enterFullscreen', texts } : { method: 'enterFullscreen' });
    }
    exitFullscreen(): void {
        this.record({ method: 'exitFullscreen' });
    }
    destroy(): void {
        this.record({ method: 'destroy' });
    }

    snapshot(): EngineSnapshot {
        return {
            currentTime: this.position(),
            duration: this.duration,
            bufferedEnd: this.bufferedEnd,
            playing: this.isPlaying,
        };
    }

    position(): number {
        if (!this.isPlaying) return this.basePosition;
        return this.basePosition + (this.clock.now() - this.baseTime) * this.rate;
    }

    // Signals: the engine's side of the story.

    signal(signal: string, args: JsonObject): void {
        switch (signal) {
            case 'readyToPlay':
                this.duration = args.duration === undefined ? 0 : (args.duration as number | null);
                this.hasVideo = args.hasVideo !== false;
                this.listener?.readyToPlay(this.duration);
                return;
            case 'playing':
                this.setPosition(this.position());
                this.isPlaying = true;
                this.listener?.playing();
                return;
            case 'paused':
                this.setPosition(this.position());
                this.isPlaying = false;
                this.listener?.paused();
                return;
            case 'buffering':
                this.listener?.buffering();
                return;
            case 'seeked':
                this.setPosition(args.position as number);
                this.listener?.seeked();
                return;
            case 'ended':
                this.setPosition(this.position());
                this.isPlaying = false;
                this.listener?.ended();
                return;
            case 'tracks':
                this.listener?.tracks(args.tracks ?? [], args.activeId ?? null);
                return;
            case 'variants':
                this.listener?.variants(args.variants ?? []);
                return;
            case 'bufferedTo':
                this.bufferedEnd = args.end as number;
                this.listener?.bufferedTo(this.bufferedEnd);
                return;
            case 'position':
                this.setPosition(args.position as number);
                return;
            case 'rate':
                this.setPosition(this.position());
                this.rate = args.rate as number;
                this.listener?.rateChanged(this.rate);
                return;
            case 'muted':
                this.listener?.mutedChanged(args.muted as boolean);
                return;
            case 'failed':
                throw new Error('failed: the recovery ladder arrives in phase 3');
            default:
                throw new Error(`Unknown engine signal ${signal}`);
        }
    }

    private setPosition(position: number): void {
        this.basePosition = position;
        this.baseTime = this.clock.now();
    }

    private record(call: JsonObject): void {
        this.log.push(call);
    }
}
