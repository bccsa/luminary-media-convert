import { type MockInstance } from 'vitest';

const mockLookup = vi.hoisted(() => vi.fn());
vi.mock('dns/promises', () => ({
    lookup: mockLookup,
}));

import { WebhookService } from './webhook.service.js';

describe('WebhookService', () => {
    let service: WebhookService;
    let fetchSpy: MockInstance;

    beforeEach(() => {
        service = new WebhookService();
        fetchSpy = vi.spyOn(globalThis, 'fetch');
        mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        vi.clearAllMocks();
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

    describe('SSRF protection', () => {
        const payload = { sessionId: 's1', status: 'encoding' as const };

        it('should block 169.254.x.x (cloud metadata) URLs', async () => {
            await service.send('https://169.254.169.254/latest/meta-data', 'tok', payload);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('should block hostnames that resolve to cloud metadata IPs', async () => {
            mockLookup.mockResolvedValue({ address: '169.254.169.254', family: 4 });
            await service.send('https://evil.example.com/webhook', 'tok', payload);
            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it('should allow localhost URLs (authenticated users may use local services)', async () => {
            fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
            mockLookup.mockResolvedValue({ address: '127.0.0.1', family: 4 });
            await service.send('https://localhost/webhook', 'tok', payload);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('should allow private network URLs', async () => {
            fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
            mockLookup.mockResolvedValue({ address: '10.0.0.1', family: 4 });
            await service.send('https://10.0.0.1/webhook', 'tok', payload);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });

        it('should allow public hostnames', async () => {
            fetchSpy.mockResolvedValue({ ok: true, status: 200 } as Response);
            mockLookup.mockResolvedValue({ address: '93.184.216.34', family: 4 });

            await service.send('https://example.com/webhook', 'tok', payload);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        });
    });
});
