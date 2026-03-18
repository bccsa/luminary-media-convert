import { describe, it, expect } from 'vitest';
import { MeController } from './me.controller.js';

describe('MeController', () => {
    const controller = new MeController();

    it('should return the current user identity', () => {
        const req = {
            user: {
                _id: 'user:123',
                email: 'test@example.com',
                name: 'Test User',
                role: 'user',
                status: 'active',
            },
        };

        const result = controller.me(req);

        expect(result).toEqual({
            id: 'user:123',
            email: 'test@example.com',
            name: 'Test User',
            role: 'user',
            status: 'active',
        });
    });
});
