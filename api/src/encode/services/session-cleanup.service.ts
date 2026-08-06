import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SessionService } from './session.service.js';

const DEFAULT_ABANDONED_MAX_AGE_HOURS = 6;

/**
 * Sweeps abandoned sessions off the encoder.
 *
 * Only sessions that were started and never finished — an upload nobody went on
 * to encode, a config screen closed on. Those are bounded by nothing else: a
 * closed tab leaves its gigabytes on the volume for the life of the host.
 *
 * Finished sessions are not swept on a clock. They are discarded at boot
 * instead, which means no age threshold has to stand in for "the user is done
 * looking at this" — a local app is restarted often enough, and until then the
 * session is exactly what the user expects to still be on screen.
 */
@Injectable()
export class SessionCleanupService {
    private readonly logger = new Logger(SessionCleanupService.name);

    constructor(private readonly sessionService: SessionService) {}

    /** Hourly by default: disk is reclaimed soon after a session goes idle. */
    @Cron(process.env.SESSION_CLEANUP_CRON?.trim() || '0 * * * *')
    sweep(): number {
        const idleHours = this.abandonedMaxAgeHours();
        const abandoned = this.sessionService.cleanupAbandoned(
            idleHours * 60 * 60 * 1000,
        );
        if (abandoned > 0) {
            this.logger.log(
                `Swept ${abandoned} session(s) abandoned for over ${idleHours}h`,
            );
        }

        return abandoned;
    }

    /**
     * How long a session may sit idle before it is treated as abandoned.
     *
     * A forgotten upload is holding space nobody is going to use, so the window
     * is short. Misconfiguration falls back rather than deleting early.
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
