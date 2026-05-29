import { ref, watch, type Ref } from 'vue';

interface EtaSample {
    time: number;
    progress: number;
}

function computeRemainingSec(
    samples: EtaSample[],
    currentProgress: number,
    now: number,
): number | undefined {
    if (samples.length < 2) return undefined;
    const oldest = samples[0]!;
    const elapsed = (now - oldest.time) / 1000;
    const progressDelta = currentProgress - oldest.progress;
    if (progressDelta <= 0 || elapsed <= 0) return undefined;
    const rate = progressDelta / elapsed;
    const remainingSec = (100 - currentProgress) / rate;
    if (remainingSec < 0 || !Number.isFinite(remainingSec)) return undefined;
    return remainingSec;
}

function formatEtaLabel(remainingSec: number, now: number): string {
    const remainingLabel =
        remainingSec >= 3600
            ? `~${Math.round(remainingSec / 3600)} hr remaining`
            : remainingSec >= 60
              ? `~${Math.round(remainingSec / 60)} min remaining`
              : `~${Math.round(remainingSec)} sec remaining`;
    const timeStr = new Date(now + remainingSec * 1000).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
    });
    return `${remainingLabel} · Est. completion: ${timeStr}`;
}

/**
 * Rolling ETA label derived from a 0–100 progress signal.
 *
 * `progress` returns the current percentage (1–100) or null/≤0 when the
 * tracked phase is inactive (which clears the label). A 30-second sample
 * window smooths the rate.
 */
export function useEncodeEta(
    progress: () => number | null | undefined,
): { etaDisplay: Ref<string | undefined> } {
    const samples: EtaSample[] = [];
    const etaDisplay = ref<string | undefined>();

    watch(progress, (value) => {
        if (value == null || value <= 0) {
            samples.length = 0;
            etaDisplay.value = undefined;
            return;
        }
        const now = Date.now();
        samples.push({ time: now, progress: value });
        const cutoff = now - 30_000;
        while (samples.length > 1 && samples[0]!.time < cutoff) samples.shift();
        const remainingSec = computeRemainingSec(samples, value, now);
        etaDisplay.value =
            remainingSec === undefined
                ? undefined
                : formatEtaLabel(remainingSec, now);
    });

    return { etaDisplay };
}
