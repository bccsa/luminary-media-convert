import type { SleepTimerOption, SleepTimerState } from './types.js';

/**
 * A sleep timer: playback stops after a while, or at the end of the chapter that was playing.
 *
 * Minutes run on the wall clock, so pausing for a moment does not stretch them; the chapter timer waits for
 * the playhead to leave the chapter. It is the controller's to start and stop, and the engine's `pause` is
 * what it calls when it fires.
 *
 * A timer in JavaScript is only as good as JavaScript's own running: a web view that a locked screen has
 * suspended does not fire it. On the web that is fine; a native shell should do the same job beside the
 * engine (see `docs/suspension-safe-playback.md`), which is what `PlayerAdapter.setSleepTimer` is for.
 */
export class SleepTimer {
    private timeout: ReturnType<typeof setTimeout> | undefined;
    private current: SleepTimerState | null = null;

    constructor(
        private readonly fire: () => void,
        private readonly changed: (state: SleepTimerState | null) => void,
        private readonly now: () => number = Date.now
    ) {}

    get state(): SleepTimerState | null {
        return this.current;
    }

    /** Starts, replaces or (with `null`) clears the timer. A chapter timer needs the chapter's end: `chapterEnd`. */
    set(option: SleepTimerOption | null, chapterEnd?: number): void {
        this.clear();
        if (!option) return;
        if (option.kind === 'minutes') {
            if (!Number.isFinite(option.minutes) || !(option.minutes > 0)) return;
            const delay = option.minutes * 60_000;
            this.current = { kind: 'minutes', endsAt: this.now() + delay };
            this.timeout = setTimeout(() => this.trip(), delay);
        } else {
            if (chapterEnd === undefined || !Number.isFinite(chapterEnd)) return;
            this.current = { kind: 'chapter', endTime: chapterEnd };
        }
        this.changed(this.current);
    }

    /** The media time has moved: a chapter timer ends when the playhead reaches the chapter's end. */
    onTime(currentTime: number): void {
        if (this.current?.kind === 'chapter' && currentTime >= this.current.endTime) this.trip();
    }

    /** A new source ends a chapter timer (its chapter is gone) and leaves a minutes timer running. */
    onNewSource(): void {
        if (this.current?.kind === 'chapter') this.clear();
    }

    clear(): void {
        clearTimeout(this.timeout);
        this.timeout = undefined;
        if (this.current) {
            this.current = null;
            this.changed(null);
        }
    }

    private trip(): void {
        this.clear();
        this.fire();
    }
}
