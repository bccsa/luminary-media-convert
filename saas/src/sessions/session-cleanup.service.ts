import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service.js';
import { SessionDocument } from './interfaces/session-document.interface.js';

@Injectable()
export class SessionCleanupService {
    private readonly logger = new Logger(SessionCleanupService.name);

    constructor(private readonly databaseService: DatabaseService) {}

    @Cron(process.env.SESSION_EXPIRY_CRON?.trim() || '0 3 * * *')
    async cleanupExpiredSessions(): Promise<number> {
        const now = new Date().toISOString();

        const result = await this.databaseService.find<SessionDocument>({
            selector: {
                docType: 'session',
                expiresAt: { $lt: now },
            },
            use_index: 'sessions-by-expiry',
            limit: 500,
        });

        if (result.docs.length === 0) return 0;

        const deletions = result.docs.map((doc) => ({
            _id: doc._id,
            _rev: doc._rev!,
            _deleted: true,
        }));

        await this.databaseService.bulk({ docs: deletions as any });

        this.logger.log(
            `Cleaned up ${deletions.length} expired session(s)`,
        );

        return deletions.length;
    }
}
