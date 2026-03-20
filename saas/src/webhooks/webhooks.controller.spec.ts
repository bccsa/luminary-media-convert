import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebhooksController } from './webhooks.controller.js';
import { WebhooksService } from './webhooks.service.js';

describe('WebhooksController', () => {
    let controller: WebhooksController;
    let service: {
        validateWebhookToken: ReturnType<typeof vi.fn>;
        processEncodingWebhook: ReturnType<typeof vi.fn>;
        checkAuthorization: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
        service = {
            validateWebhookToken: vi.fn(),
            processEncodingWebhook: vi.fn().mockResolvedValue(undefined),
            checkAuthorization: vi.fn().mockResolvedValue({ allowed: true }),
        };
        controller = new WebhooksController(service as unknown as WebhooksService);
    });

    describe('encoding', () => {
        it('should validate token and process webhook', async () => {
            const dto = { sessionId: 'sess-1', status: 'encoding' };
            const result = await controller.encoding('secret', dto as any);

            expect(service.validateWebhookToken).toHaveBeenCalledWith('secret');
            expect(service.processEncodingWebhook).toHaveBeenCalledWith(dto);
            expect(result).toEqual({ received: true });
        });
    });

    describe('authorize', () => {
        it('should return authorization result', async () => {
            const dto = { action: 'create_session', userId: 'user:1' };
            const result = await controller.authorize(dto as any);

            expect(service.checkAuthorization).toHaveBeenCalledWith(dto);
            expect(result).toEqual({ allowed: true });
        });
    });
});
