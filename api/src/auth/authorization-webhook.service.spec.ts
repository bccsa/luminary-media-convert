import { ForbiddenException } from '@nestjs/common';
import { AuthorizationWebhookService } from './authorization-webhook.service';
import type { ValidatedKeyMetadata } from './key-validation.types';

function makeApiKey(overrides: Partial<ValidatedKeyMetadata> = {}): ValidatedKeyMetadata {
    return {
        userId: 'user-1',
        ...overrides,
    };
}

describe('AuthorizationWebhookService', () => {
    let service: AuthorizationWebhookService;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        service = new AuthorizationWebhookService();
        fetchSpy = vi.spyOn(globalThis, 'fetch');
        delete process.env.AUTHORIZATION_WEBHOOK_URL;
        delete process.env.AUTHORIZATION_FAIL_MODE;
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        delete process.env.AUTHORIZATION_WEBHOOK_URL;
        delete process.env.AUTHORIZATION_FAIL_MODE;
    });

    it('should allow when no URL is configured (standalone mode)', async () => {
        await expect(
            service.checkAuthorization('create_session', {}),
        ).resolves.toBeUndefined();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('should allow when the webhook responds with allowed: true', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';

        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ allowed: true }), { status: 200 }),
        );

        await expect(
            service.checkAuthorization('create_session', {
                apiKey: makeApiKey(),
            }),
        ).resolves.toBeUndefined();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('should throw ForbiddenException when denied with reason', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';

        fetchSpy.mockResolvedValue(
            new Response(
                JSON.stringify({ allowed: false, reason: 'Quota exceeded' }),
                { status: 200 },
            ),
        );

        await expect(
            service.checkAuthorization('create_session', {
                apiKey: makeApiKey(),
            }),
        ).rejects.toThrow('Quota exceeded');
    });

    it('should throw ForbiddenException with default message when denied without reason', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';

        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ allowed: false }), { status: 200 }),
        );

        await expect(
            service.checkAuthorization('create_session', {}),
        ).rejects.toThrow('Authorization denied');
    });

    it('should allow on 5xx with fail-open (default)', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';

        fetchSpy.mockResolvedValue(
            new Response('Internal Server Error', { status: 500 }),
        );

        await expect(
            service.checkAuthorization('create_session', {}),
        ).resolves.toBeUndefined();
    });

    it('should throw ForbiddenException on 5xx with fail-closed', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';
        process.env.AUTHORIZATION_FAIL_MODE = 'closed';

        fetchSpy.mockResolvedValue(
            new Response('Internal Server Error', { status: 500 }),
        );

        await expect(
            service.checkAuthorization('create_session', {}),
        ).rejects.toThrow(ForbiddenException);
    });

    it('should allow on network error with fail-open', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';

        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(
            service.checkAuthorization('create_session', {}),
        ).resolves.toBeUndefined();
    });

    it('should throw ForbiddenException on network error with fail-closed', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';
        process.env.AUTHORIZATION_FAIL_MODE = 'closed';

        fetchSpy.mockRejectedValue(new Error('ECONNREFUSED'));

        await expect(
            service.checkAuthorization('create_session', {}),
        ).rejects.toThrow(ForbiddenException);
    });

    it('should use per-key authorizationUrl over global env var', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://global.example.com/check';

        const apiKey = makeApiKey({
            authorizationUrl: 'https://per-key.example.com/check',
        });

        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ allowed: true }), { status: 200 }),
        );

        await service.checkAuthorization('create_session', { apiKey });

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://per-key.example.com/check',
            expect.any(Object),
        );
    });

    it('should send correct payload in request body', async () => {
        process.env.AUTHORIZATION_WEBHOOK_URL = 'https://auth.example.com/check';

        const apiKey = makeApiKey({
            userId: 'key-42',
            metadata: { tenant: 'acme' },
        });

        fetchSpy.mockResolvedValue(
            new Response(JSON.stringify({ allowed: true }), { status: 200 }),
        );

        await service.checkAuthorization('start_encode', {
            apiKey,
            sessionId: 'sess-123',
        });

        const callArgs = fetchSpy.mock.calls[0];
        const body = JSON.parse(callArgs[1]!.body as string);
        expect(body).toEqual({
            action: 'start_encode',
            userId: 'key-42',
            sessionId: 'sess-123',
            metadata: { tenant: 'acme' },
        });
    });
});
