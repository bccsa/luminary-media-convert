import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

@Injectable()
export class DashboardService {
    constructor(private readonly databaseService: DatabaseService) {}

    async getStats(): Promise<{
        userCounts: { total: number; active: number; disabled: number };
        sessionCounts: { total: number; active: number; completed: number; failed: number };
        recentActivity: unknown[];
    }> {
        const [users, sessions, recentSessions] = await Promise.all([
            this.databaseService.find<any>({
                selector: { docType: 'user' },
                fields: ['status'],
                limit: 10000,
            }),
            this.databaseService.find<any>({
                selector: { docType: 'session' },
                fields: ['status'],
                limit: 10000,
            }),
            this.databaseService.find<any>({
                selector: {
                    docType: 'session',
                    status: { $in: ['completed', 'failed'] },
                },
                sort: [{ docType: 'desc' as const }, { updatedAt: 'desc' as const }],
                limit: 10,
                use_index: 'sessions-by-updated',
            }),
        ]);

        const userDocs = users.docs;
        const sessionDocs = sessions.docs;

        const activeStatuses = ['created', 'uploaded', 'uploading', 'queued', 'encoding', 'encrypting', 'uploading_to_s3'];

        return {
            userCounts: {
                total: userDocs.length,
                active: userDocs.filter((u: any) => u.status === 'active').length,
                disabled: userDocs.filter((u: any) => u.status === 'disabled').length,
            },
            sessionCounts: {
                total: sessionDocs.length,
                active: sessionDocs.filter((s: any) => activeStatuses.includes(s.status)).length,
                completed: sessionDocs.filter((s: any) => s.status === 'completed').length,
                failed: sessionDocs.filter((s: any) => s.status === 'failed').length,
            },
            recentActivity: recentSessions.docs.map((s: any) => ({
                sessionId: s.sessionId,
                userId: s.userId,
                status: s.status,
                updatedAt: s.updatedAt,
                completedAt: s.completedAt,
            })),
        };
    }
}
