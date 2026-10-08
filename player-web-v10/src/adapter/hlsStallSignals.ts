import { Hls } from '@videojs/hlsjs-video';
import type { HlsEngine, HlsErrorData } from './hlsTypes';

/** hls.js error details that mean playback stopped moving and the engine intervened. */
const STALL_DETAILS = new Set<string>([
    Hls.ErrorDetails.BUFFER_STALLED_ERROR,
    Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL,
    Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE,
]);

export interface HlsStallSignalHooks {
    /** Stall state changed. */
    onStalled: (stalled: boolean) => void;
}

/**
 * Stall detection, as hls.js reports it.
 *
 * hls.js's gap controller nudges a stuck playhead up to `nudgeMaxRetry` times and then raises a
 * fatal `BUFFER_STALLED_ERROR`, which reaches the recovery ladder as an ordinary fatal error — so
 * there is no strike counting here, unlike the VHS version.
 */
export class HlsStallSignals {
    private engine: HlsEngine | null = null;
    private stalled = false;
    private lastTime = 0;

    constructor(private readonly hooks: HlsStallSignalHooks) {}

    /** Listen on this engine; re-subscribes only when it is a different one. */
    attach(engine: HlsEngine | null): void {
        if (engine === this.engine) return;
        this.detach();
        if (!engine) return;
        this.engine = engine;
        engine.on(Hls.Events.ERROR, this.onError);
    }

    detach(): void {
        this.engine?.off(Hls.Events.ERROR, this.onError);
        this.engine = null;
    }

    /** A playhead sample. Forward movement ends the stall. */
    noteTime(seconds: number): void {
        if (seconds <= this.lastTime) return;
        this.lastTime = seconds;
        this.clear();
    }

    /** A seek moved the playhead without playback having progressed. */
    resetBaseline(seconds: number): void {
        this.lastTime = seconds;
    }

    /** Pause, end, a new source: nothing is stalled. */
    clear(): void {
        this.setStalled(false);
    }

    private readonly onError = (_event: string, data: HlsErrorData): void => {
        if (data.fatal || !STALL_DETAILS.has(data.details)) return;
        this.setStalled(true);
    };

    private setStalled(stalled: boolean): void {
        if (this.stalled === stalled) return;
        this.stalled = stalled;
        this.hooks.onStalled(stalled);
    }
}
