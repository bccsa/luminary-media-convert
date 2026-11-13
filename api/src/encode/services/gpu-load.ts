import { execFile } from 'child_process';
import { promisify } from 'util';
import type { AccelMode } from './encoder-selection';

const execFileAsync = promisify(execFile);

/** Utilisation at or above which the GPU counts as saturated, percent. */
export const GPU_STARVED_PERCENT = 95;

/** How often utilisation is read while previews are being made. */
const SAMPLE_INTERVAL_MS = 2_000;

/** How long after the last preview segment the sampling stops. */
const IDLE_AFTER_MS = 10_000;

/** Reads the GPU's utilisation, percent, or null when it cannot be read. */
export type GpuLoadSampler = () => Promise<number | null>;

/**
 * NVIDIA: the busier of the encoder and decoder engines. A preview segment
 * needs both, and either one saturated by the ladder is what makes it slow;
 * the 3D engine's figure says nothing about either.
 */
async function sampleNvidia(): Promise<number | null> {
    const { stdout } = await execFileAsync(
        'nvidia-smi',
        [
            '--query-gpu=utilization.encoder,utilization.decoder',
            '--format=csv,noheader,nounits',
        ],
        { timeout: 2_000 }
    );
    const values = String(stdout)
        .split(/[\s,]+/)
        .map(Number)
        .filter(Number.isFinite);
    return values.length > 0 ? Math.max(...values) : null;
}

/**
 * macOS: the IOAccelerator's "Device Utilization %", readable without root.
 * It measures the GPU cores rather than the media engines that encode, so it
 * misses a saturated encoder — but it catches a saturated GPU, and the permit
 * and the latency check cover the encoder.
 */
async function sampleIoreg(): Promise<number | null> {
    const { stdout } = await execFileAsync(
        'ioreg',
        ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator'],
        { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }
    );
    const matches = [
        ...String(stdout).matchAll(/"Device Utilization %"\s*=\s*(\d+)/g),
    ].map((match) => Number(match[1]));
    return matches.length > 0 ? Math.max(...matches) : null;
}

/** The sampler for this machine's encoder, or one that never knows. */
export function gpuLoadSampler(
    mode: AccelMode,
    platform: NodeJS.Platform = process.platform
): GpuLoadSampler {
    if (mode === 'nvidia') return sampleNvidia;
    if (mode === 'apple' && platform === 'darwin') return sampleIoreg;
    return async () => null;
}

/**
 * How busy the GPU is, sampled only while somebody is watching a converted
 * preview.
 *
 * A preview segment made on a GPU the ladder has saturated is a stall, so a
 * segment asks this first and goes to the CPU when the answer is yes. Reading
 * the figure costs a process every couple of seconds, which is why it is read
 * only while preview segments are being asked for and stops by itself shortly
 * after the last one. A figure that cannot be read is no figure: not starved.
 */
export class GpuLoadMonitor {
    private percent: number | null = null;
    private timer: NodeJS.Timeout | null = null;
    private lastDemand = 0;
    private sampling = false;

    constructor(
        private readonly sampler: GpuLoadSampler,
        private readonly now: () => number = Date.now
    ) {}

    /**
     * A segment wants the GPU: sample, if not already sampling. The first
     * reading comes a sampling interval later, so a few segments asked for once
     * cost no process at all; the session permit and the latency check stand
     * guard until then.
     */
    noteDemand(): void {
        this.lastDemand = this.now();
        if (this.timer) return;
        this.timer = setInterval(() => void this.sample(), SAMPLE_INTERVAL_MS);
        this.timer.unref?.();
    }

    /** The last reading, percent, or null when there is none. */
    get utilisation(): number | null {
        return this.percent;
    }

    isStarved(): boolean {
        return this.percent !== null && this.percent >= GPU_STARVED_PERCENT;
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.percent = null;
    }

    private async sample(): Promise<void> {
        if (this.now() - this.lastDemand > IDLE_AFTER_MS) {
            this.stop();
            return;
        }
        if (this.sampling) return;
        this.sampling = true;
        try {
            this.percent = await this.sampler();
        } catch {
            this.percent = null;
        } finally {
            this.sampling = false;
        }
    }
}
