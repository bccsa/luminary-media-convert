import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SessionService } from './session.service.js';

const DEFAULT_MAX_AGE_HOURS = 24;

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
        return removed;
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
}
