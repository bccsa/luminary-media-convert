import { reactive } from 'vue';
import { Samples } from './samples';

/**
 * Rejections a correct TypeScript half never provokes. `stale-generation` and `unknown-player`
 * are races a storm can legitimately cause (a late call for a player just replaced).
 */
export const BROKEN_REJECTIONS = new Set(['invalid-argument', 'protocol-mismatch', 'engine']);

/** Every bridge call the lab's native player made: latency per method, rejections, load sizes. */
export const bridgeStats = reactive({
    calls: {} as Record<string, Samples>,
    rejections: [] as { method: string; code: string; message: string; at: number }[],
    loadBytes: new Samples(),

    resolved(method: string, ms: number) {
        (this.calls[method] ??= new Samples()).add(ms);
    },

    rejected(method: string, ms: number, code: string, message: string) {
        (this.calls[method] ??= new Samples()).add(ms);
        this.rejections.push({ method, code, message, at: Date.now() });
        if (this.rejections.length > 50) this.rejections.shift();
    },

    loadPayload(bytes: number) {
        this.loadBytes.add(bytes);
    },

    reset() {
        this.calls = {};
        this.rejections = [];
        this.loadBytes = new Samples();
    },
});
