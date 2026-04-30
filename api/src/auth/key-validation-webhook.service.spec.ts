import { KeyValidationWebhookService } from './key-validation-webhook.service';

describe('KeyValidationWebhookService', () => {
    let service: KeyValidationWebhookService;
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    const savedWebhookUrl = process.env.KEY_VALIDATION_WEBHOOK_URL;
    const savedCacheTtl = process.env.KEY_VALIDATION_CACHE_TTL_MS;
    const savedTimeout = process.env.KEY_VALIDATION_WEBHOOK_TIMEOUT_MS;

    beforeEach(() => {
        service = new KeyValidationWebhookService();
        fetchSpy = vi.spyOn(globalThis, 'fetch');
        delete process.env.KEY_VALIDATION_WEBHOOK_URL;
        delete process.env.KEY_VALIDATION_CACHE_TTL_MS;
        delete process.env.KEY_VALIDATION_WEBHOOK_TIMEOUT_MS;
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        if (savedWebhookUrl !== undefined) {
            process.env.KEY_VALIDATION_WEBHOOK_URL = savedWebhookUrl;
        } else {
            delete process.env.KEY_VALIDATION_WEBHOOK_URL;
        }
        if (savedCacheTtl !== undefined) {
            process.env.KEY_VALIDATION_CACHE_TTL_MS = savedCacheTtl;
        } else {
            delete process.env.KEY_VALIDATION_CACHE_TTL_MS;
        }
        if (savedTimeout !== undefined) {
            process.env.KEY_VALIDATION_WEBHOOK_TIMEOUT_MS = savedTimeout;
        } else {
            delete process.env.KEY_VALIDATION_WEBHOOK_TIMEOUT_MS;
        }
    });

    it('should return null when KEY_VALIDATION_WEBHOOK_URL is not set', async () => {
        const result = await service.validateKey('some-key');

        expect(result).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should return metadata when webhook returns valid: true', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';

        fetchSpy.mockResolvedValue(
            new Response(
                JSON.stringify({
                    valid: true,
                    metadata: {
                        userId: 'user-1',
                        webhookUrl: 'https://example.com/hook',
                    },
                }),
                { status: 200 },
            ),
        );

        const result = await service.validateKey('test-api-key');

        expect(result).toEqual({
            userId: 'user-1',
            webhookUrl: 'https://example.com/hook',
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should return null when webhook returns valid: false', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';

        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ valid: false }), { status: 200 }),
        );

        const result = await service.validateKey('bad-key');

        expect(result).toBeNull();
    });

    it('should return null on network error', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';

        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

        const result = await service.validateKey('some-key');

        expect(result).toBeNull();
    });

    it('should return null on timeout', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';

        fetchSpy.mockRejectedValue(new DOMException('Aborted', 'AbortError'));

        const result = await service.validateKey('some-key');

        expect(result).toBeNull();
    });

    it('should return null on 5xx response', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';

        fetchSpy.mockResolvedValue(
            new Response('Internal Server Error', { status: 500 }),
        );

        const result = await service.validateKey('some-key');

        expect(result).toBeNull();
    });

    it('should cache successful validation (second call skips fetch)', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';
        process.env.KEY_VALIDATION_CACHE_TTL_MS = '60000';

        fetchSpy.mockResolvedValue(
            new Response(
                JSON.stringify({
                    valid: true,
                    metadata: { userId: 'user-1' },
                }),
                { status: 200 },
            ),
        );

        const result1 = await service.validateKey('cached-key');
        const result2 = await service.validateKey('cached-key');

        expect(result1).toEqual({ userId: 'user-1' });
        expect(result2).toEqual({ userId: 'user-1' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should expire cache after TTL', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';
        process.env.KEY_VALIDATION_CACHE_TTL_MS = '1'; // 1ms TTL

        fetchSpy.mockResolvedValue(
            new Response(
                JSON.stringify({
                    valid: true,
                    metadata: { userId: 'user-1' },
                }),
                { status: 200 },
            ),
        );

        await service.validateKey('expiring-key');

        // Wait for cache to expire
        await new Promise((resolve) => setTimeout(resolve, 10));

        await service.validateKey('expiring-key');

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('should clear cache when clearCache() is called', async () => {
        process.env.KEY_VALIDATION_WEBHOOK_URL =
            'https://auth.example.com/validate';

        fetchSpy.mockResolvedValue(
            new Response(
                JSON.stringify({
                    valid: true,
                    metadata: { userId: 'user-1' },
                }),
                { status: 200 },
            ),
        );

        await service.validateKey('some-key');
        service.clearCache();
        await service.validateKey('some-key');

        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
});
