import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionCleanupService } from './session-cleanup.service.js';

const mockDatabaseService = {
    find: vi.fn(),
    bulk: vi.fn().mockResolvedValue([]),
};

describe('SessionCleanupService', () => {
    let service: SessionCleanupService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new SessionCleanupService(mockDatabaseService as any);
    });

    it('should delete expired sessions', async () => {
        mockDatabaseService.find.mockResolvedValue({
            docs: [
                { _id: 'session:1', _rev: '1-a' },
                { _id: 'session:2', _rev: '1-b' },
            ],
        });

        const count = await service.cleanupExpiredSessions();

        expect(count).toBe(2);
        expect(mockDatabaseService.bulk).toHaveBeenCalledWith({
            docs: [
                { _id: 'session:1', _rev: '1-a', _deleted: true },
                { _id: 'session:2', _rev: '1-b', _deleted: true },
            ],
        });
    });

    it('should return 0 when no expired sessions', async () => {
        mockDatabaseService.find.mockResolvedValue({ docs: [] });

        const count = await service.cleanupExpiredSessions();

        expect(count).toBe(0);
        expect(mockDatabaseService.bulk).not.toHaveBeenCalled();
    });
});
