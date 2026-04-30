import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardService } from './dashboard.service.js';

const mockDatabaseService = {
    find: vi.fn(),
};

describe('DashboardService', () => {
    let service: DashboardService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new DashboardService(mockDatabaseService as any);
    });

    it('should return aggregated stats', async () => {
        mockDatabaseService.find
            .mockResolvedValueOnce({
                docs: [
                    { status: 'active' },
                    { status: 'active' },
                    { status: 'disabled' },
                ],
            })
            .mockResolvedValueOnce({
                docs: [
                    { status: 'completed' },
                    { status: 'completed' },
                    { status: 'failed' },
                    { status: 'encoding' },
                ],
            })
            .mockResolvedValueOnce({
                docs: [
                    { sessionId: 's1', userId: 'u1', status: 'completed', updatedAt: '2026-01-01', completedAt: '2026-01-01' },
                ],
            });

        const result = await service.getStats();

        expect(result.userCounts).toEqual({ total: 3, active: 2, disabled: 1 });
        expect(result.sessionCounts).toEqual({ total: 4, active: 1, completed: 2, failed: 1 });
        expect(result.recentActivity).toHaveLength(1);
    });
});
