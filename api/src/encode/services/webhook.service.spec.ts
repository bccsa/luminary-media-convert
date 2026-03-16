import { type MockInstance } from 'vitest';
import { WebhookService } from './webhook.service.js';

describe('WebhookService', () => {
    let service: WebhookService;
    let fetchSpy: MockInstance;

    beforeEach(() => {
        service = new WebhookService();
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        fetchSpy.mockRestore();
    });

    it('should POST payload with correct headers', async () => {
        fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);

        const payload = {
            sessionId: 'sess-1',
            status: 'encoding' as const,
            progress: 50,
        };

        await service.send(
            'https://example.com/webhook',
            'my-token',
            payload
        );

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, options] = fetchSpy.mock.calls[0];
        expect(url).toBe('https://example.com/webhook');
        expect(options.method).toBe('POST');
        expect(options.headers['Content-Type']).toBe('application/json');
        expect(options.headers['X-Session-Token']).toBe('my-token');
        expect(JSON.parse(options.body)).toEqual(payload);
    });

    it('should not throw when fetch returns a non-ok response', async () => {
        fetchSpy.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
        } as Response);

        await expect(
            service.send('https://example.com/webhook', 'tok', {
                sessionId: 's1',
                status: 'encoding',
            })
        ).resolves.toBeUndefined();
    });

    it('should not throw when fetch rejects (network error)', async () => {
        fetchSpy.mockRejectedValue(new Error('Network error'));

        await expect(
            service.send('https://example.com/webhook', 'tok', {
                sessionId: 's1',
                status: 'failed',
                error: 'boom',
            })
        ).resolves.toBeUndefined();
    });
});
