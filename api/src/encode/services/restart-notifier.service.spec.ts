import { type Mocked } from 'vitest';
import { RestartNotifierService } from './restart-notifier.service.js';
import { SessionService } from './session.service.js';
import { WebhookService } from './webhook.service.js';

function makeSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sess-1',
        status: 'failed',
        error: 'The encoder restarted while this session was in progress.',
        config: {
            webhook: { url: 'https://example.com/hook', sessionToken: 'tok' },
        },
        ...overrides,
    } as any;
}

describe('RestartNotifierService', () => {
    let sessionService: Mocked<SessionService>;
    let webhookService: Mocked<WebhookService>;
    let service: RestartNotifierService;

    beforeEach(() => {
        sessionService = {
            takeRestartFailures: vi.fn().mockReturnValue([]),
        } as unknown as Mocked<SessionService>;
        webhookService = {
            send: vi.fn().mockResolvedValue(undefined),
        } as unknown as Mocked<WebhookService>;
        service = new RestartNotifierService(sessionService, webhookService);
    });

    it('reports a session the restart killed, so the record stops saying "encoding"', async () => {
        sessionService.takeRestartFailures.mockReturnValue([makeSession()]);

        await service.notify();

        expect(webhookService.send).toHaveBeenCalledWith(
            'https://example.com/hook',
            'tok',
            expect.objectContaining({
                sessionId: 'sess-1',
                status: 'failed',
                error: 'The encoder restarted while this session was in progress.',
            })
        );
    });

    it('sends nothing when the restart killed nothing', async () => {
        await service.notify();

        expect(webhookService.send).not.toHaveBeenCalled();
    });

    it('skips a session that was created without a webhook', async () => {
        sessionService.takeRestartFailures.mockReturnValue([
            makeSession({ config: {} }),
        ]);

        await expect(service.notify()).resolves.toBe(0);
        expect(webhookService.send).not.toHaveBeenCalled();
    });

    it('still reports the rest when one receiver is unreachable', async () => {
        sessionService.takeRestartFailures.mockReturnValue([
            makeSession({ id: 'sess-1' }),
            makeSession({ id: 'sess-2' }),
        ]);
        webhookService.send.mockRejectedValueOnce(new Error('unreachable'));

        const sent = await service.notify();

        expect(sent).toBe(1);
        expect(webhookService.send).toHaveBeenCalledTimes(2);
    });

    it('does not let a failing receiver take down startup', () => {
        sessionService.takeRestartFailures.mockReturnValue([makeSession()]);
        webhookService.send.mockRejectedValue(new Error('unreachable'));

        expect(() => service.onApplicationBootstrap()).not.toThrow();
    });
});
