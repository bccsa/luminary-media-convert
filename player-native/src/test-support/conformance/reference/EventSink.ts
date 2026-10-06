/**
 * The reference `EventSink`: stamps every event with its player and load, and
 * enforces the emission rules in `conformance/README.md` on the virtual clock.
 */

import type { Json, JsonObject } from '../scenario.js';
import type { VirtualClock } from './clock.js';

const TIMEUPDATE_PERIOD = 0.25;
const PROGRESS_PERIOD = 1;

export class EventSink {
    private loadId: string | null = null;
    private silent = false;
    private cancelTick: (() => void) | null = null;
    private lastProgressAt: number | null = null;
    private heldProgress: number | null = null;
    private cancelProgress: (() => void) | null = null;

    constructor(
        private readonly playerId: string,
        private readonly clock: VirtualClock,
        private readonly emit: (event: JsonObject) => void,
        /** The playhead, read when a periodic `timeupdate` fires. */
        private readonly position: () => number,
    ) {}

    /** A new load: what follows is stamped with it, and nothing of the last carries over. */
    begin(loadId: string): void {
        this.loadId = loadId;
        this.stopTicking();
        this.cancelProgress?.();
        this.cancelProgress = null;
        this.lastProgressAt = null;
        this.heldProgress = null;
    }

    /** Nothing is emitted after this, whatever the engine still reports. */
    close(): void {
        this.silent = true;
        this.stopTicking();
        this.cancelProgress?.();
    }

    send(name: string, payload: JsonObject = {}): void {
        // Before the first load there is no load to stamp an event with.
        if (this.silent || this.loadId === null) return;
        this.emit({ name, payload: { ...payload, playerId: this.playerId, loadId: this.loadId } });
    }

    // The throttled pair.

    /** The 0.25 s period starts now; there is no `timeupdate` at the transition itself. */
    startTicking(): void {
        this.stopTicking();
        this.cancelTick = this.clock.schedule(TIMEUPDATE_PERIOD, () => this.tick());
    }

    stopTicking(): void {
        this.cancelTick?.();
        this.cancelTick = null;
    }

    private tick(): void {
        this.send('timeupdate', { currentTime: this.position() });
        this.cancelTick = this.clock.schedule(TIMEUPDATE_PERIOD, () => this.tick());
    }

    /** A `timeupdate` outside the period (seek, pause); a running period restarts from it. */
    timeupdateNow(): void {
        this.send('timeupdate', { currentTime: this.position() });
        if (this.cancelTick) this.startTicking();
    }

    progress(bufferedEnd: number): void {
        const now = this.clock.now();
        if (this.lastProgressAt === null || now - this.lastProgressAt >= PROGRESS_PERIOD) {
            this.lastProgressAt = now;
            this.send('progress', { bufferedEnd });
            return;
        }
        this.heldProgress = bufferedEnd;
        this.cancelProgress ??= this.clock.schedule(this.lastProgressAt + PROGRESS_PERIOD - now, () => {
            this.cancelProgress = null;
            this.lastProgressAt = this.clock.now();
            this.send('progress', { bufferedEnd: this.heldProgress as Json });
            this.heldProgress = null;
        });
    }
}
