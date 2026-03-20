import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';

describe('DashboardController', () => {
    let controller: DashboardController;
    let dashboardService: { getStats: ReturnType<typeof vi.fn> };

    beforeEach(() => {
        dashboardService = {
            getStats: vi.fn().mockResolvedValue({
                userCounts: { total: 5, active: 4, disabled: 1 },
                sessionCounts: { total: 10, active: 2, completed: 7, failed: 1 },
                recentActivity: [],
            }),
        };
        controller = new DashboardController(
            dashboardService as unknown as DashboardService,
        );
    });

    it('should return dashboard stats', async () => {
        const result = await controller.getStats();

        expect(dashboardService.getStats).toHaveBeenCalled();
        expect(result.userCounts.total).toBe(5);
        expect(result.sessionCounts.total).toBe(10);
    });
});
