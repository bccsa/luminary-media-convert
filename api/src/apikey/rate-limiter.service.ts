import { Injectable } from '@nestjs/common';

interface WindowEntry {
    timestamps: number[];
}

export interface RateLimitResult {
    allowed: boolean;
    limit: number;
    remaining: number;
    resetAt: Date;
}

/**
 * In-memory sliding window rate limiter, keyed by API key ID.
 * Window size is 60 seconds. Limit is configurable via
 * API_KEY_RATE_LIMIT env var (default: 100 requests per window).
 */
@Injectable()
export class RateLimiterService {
    private readonly windows = new Map<string, WindowEntry>();

    private getLimit(): number {
        return parseInt(process.env.API_KEY_RATE_LIMIT || '100', 10) || 100;
    }

    check(keyId: string): RateLimitResult {
        const limit = this.getLimit();
        const now = Date.now();
        const windowMs = 60_000; // 1 minute
        const windowStart = now - windowMs;

        let entry = this.windows.get(keyId);
        if (!entry) {
            entry = { timestamps: [] };
            this.windows.set(keyId, entry);
        }

        // Prune old entries outside the sliding window
        entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

        const remaining = Math.max(0, limit - entry.timestamps.length);
        const resetAt = new Date(now + windowMs);

        if (entry.timestamps.length >= limit) {
            return { allowed: false, limit, remaining: 0, resetAt };
        }

        entry.timestamps.push(now);
        return { allowed: true, limit, remaining: remaining - 1, resetAt };
    }
}
