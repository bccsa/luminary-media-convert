import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SessionService } from './session.service.js';

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_ABANDONED_MAX_AGE_HOURS = 6;

/**
 * Sweeps finished sessions off the encoder.
 *
 * Without this nothing ever reclaims a session: `SessionService.cleanup` existed
 * but had no caller, so completed and failed sessions accumulated in memory for
 * the life of the process and their uploads accumulated on disk until a client
 * happened to delete them.
 *
 * Only completed and failed sessions are swept. A failed session keeps its source
 * until it ages out, since that is exactly when someone wants to look at the input.
 *
 * Sessions abandoned before they ever finished are swept too, on a shorter clock.
 * `cleanup` only ever looked at completed and failed, so an upload that was never
 * encoded was bounded by nothing whatsoever — a closed tab left its gigabytes on
 * the volume for the life of the host.
 */
@Injectable()
export class SessionCleanupService {
    private readonly logger = new Logger(SessionCleanupService.name);

    constructor(private readonly sessionService: SessionService) {}

    /** Hourly by default: disk is reclaimed soon after a session ages out. */
    @Cron(process.env.SESSION_CLEANUP_CRON?.trim() || '0 * * * *')
    sweep(): number {
        const hours = this.maxAgeHours();
        const removed = this.sessionService.cleanup(hours * 60 * 60 * 1000);
        if (removed > 0) {
            this.logger.log(
                `Swept ${removed} session(s) older than ${hours}h`,
            );
        }

        const idleHours = this.abandonedMaxAgeHours();
        const abandoned = this.sessionService.cleanupAbandoned(
            idleHours * 60 * 60 * 1000,
        );
        if (abandoned > 0) {
            this.logger.log(
                `Swept ${abandoned} session(s) abandoned for over ${idleHours}h`,
            );
        }

        return removed + abandoned;
    }

    /** How long a finished session is kept. Misconfiguration falls back rather than deleting early. */
    private maxAgeHours(): number {
        const raw = process.env.SESSION_MAX_AGE_HOURS?.trim();
        if (!raw) return DEFAULT_MAX_AGE_HOURS;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            this.logger.warn(
                `Ignoring SESSION_MAX_AGE_HOURS="${raw}"; using ${DEFAULT_MAX_AGE_HOURS}h`,
            );
            return DEFAULT_MAX_AGE_HOURS;
        }
        return parsed;
    }

    /**
     * How long a session may sit idle before it is treated as abandoned.
     *
     * Shorter than the finished-session window on purpose: a forgotten upload is
     * holding space nobody is going to use, while a finished one may still be
     * wanted. Misconfiguration falls back rather than deleting early.
     */
    private abandonedMaxAgeHours(): number {
        const raw = process.env.SESSION_ABANDONED_MAX_AGE_HOURS?.trim();
        if (!raw) return DEFAULT_ABANDONED_MAX_AGE_HOURS;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            this.logger.warn(
                `Ignoring SESSION_ABANDONED_MAX_AGE_HOURS="${raw}"; using ${DEFAULT_ABANDONED_MAX_AGE_HOURS}h`,
            );
            return DEFAULT_ABANDONED_MAX_AGE_HOURS;
        }
        return parsed;
    }
}
