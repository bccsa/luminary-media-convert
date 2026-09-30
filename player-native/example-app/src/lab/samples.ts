/** The last few hundred measurements of one thing, with the summaries the health board reads. */
export class Samples {
    private values: number[] = [];
    count = 0;

    constructor(private readonly keep = 300) {}

    add(value: number): void {
        this.values.push(value);
        this.count++;
        if (this.values.length > this.keep) this.values.shift();
    }

    get last(): number | null {
        return this.values.at(-1) ?? null;
    }

    get max(): number | null {
        return this.values.length ? Math.max(...this.values) : null;
    }

    percentile(p: number): number | null {
        if (!this.values.length) return null;
        const sorted = [...this.values].sort((a, b) => a - b);
        return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null;
    }

    get p50(): number | null {
        return this.percentile(50);
    }

    get p95(): number | null {
        return this.percentile(95);
    }
}
