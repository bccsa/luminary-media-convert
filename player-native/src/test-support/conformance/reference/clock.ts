/**
 * The virtual clock `EventSink` and `FakeEngine` run on. Timers due at the same
 * instant fire in the order they were set, and `now` reads the timer's own time
 * while it fires, so a position computed inside one is exact.
 */
export class VirtualClock {
    private current = 0;
    private sequence = 0;
    private timers: { at: number; seq: number; run: () => void }[] = [];

    now(): number {
        return this.current;
    }

    /** Runs `run` at `now() + delay`; returns a cancel. */
    schedule(delay: number, run: () => void): () => void {
        const timer = { at: this.current + delay, seq: this.sequence++, run };
        this.timers.push(timer);
        return () => {
            this.timers = this.timers.filter((other) => other !== timer);
        };
    }

    advance(seconds: number): void {
        const until = this.current + seconds;
        for (;;) {
            const next = this.timers
                .filter((timer) => timer.at <= until)
                .sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
            if (!next) break;
            this.timers = this.timers.filter((timer) => timer !== next);
            this.current = next.at;
            next.run();
        }
        this.current = until;
    }
}
