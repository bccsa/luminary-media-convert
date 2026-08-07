/**
 * "Coming soon" polling.
 *
 * A master playlist that does not exist yet (404, or 403 from S3 when the
 * caller has no list permission) is not an error — the encode simply has not
 * published it. The wrapper waits: one immediate check, then a FIXED interval.
 * No backoff on purpose — a viewer sitting on a "coming soon" screen wants the
 * video the moment it appears, and the request is a single tiny GET.
 */

/** Fixed re-check interval. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface PollerOptions {
    /** Re-check interval. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
    intervalMs?: number;
    /** Resolve true when the resource is available. */
    check: () => Promise<boolean>;
    /** Called once, when `check` first resolves true. The poller then stops. */
    onAvailable: () => void;
    /** Called when `check` rejects with something other than "still missing". */
    onError?: (error: unknown) => void;
    /** Run the first check immediately on `start()`. Default true. */
    immediate?: boolean;
}

/**
 * Fixed-interval poller. Checks never overlap: the next one is scheduled after
 * the previous settles.
 */
export class Poller {
    private readonly intervalMs: number;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private stopped = false;

    constructor(private readonly options: PollerOptions) {
        this.intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    }

    start(): void {
        if (this.running || this.stopped) return;
        this.running = true;
        if (this.options.immediate === false) {
            this.schedule();
        } else {
            void this.tick();
        }
    }

    stop(): void {
        this.stopped = true;
        this.running = false;
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private schedule(): void {
        if (this.stopped) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.tick();
        }, this.intervalMs);
    }

    private async tick(): Promise<void> {
        if (this.stopped) return;
        try {
            const available = await this.options.check();
            if (this.stopped) return;
            if (available) {
                this.stop();
                this.options.onAvailable();
                return;
            }
        } catch (error) {
            if (this.stopped) return;
            this.stop();
            this.options.onError?.(error);
            return;
        }
        this.schedule();
    }
}
