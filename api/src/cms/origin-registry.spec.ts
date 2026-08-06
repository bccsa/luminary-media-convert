import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    OriginRegistry,
    createOriginPolicyProvider,
    normalizeOrigin,
    type OriginPolicy,
} from './origin-registry.js';

function build(policy: OriginPolicy = {}): OriginRegistry {
    return new OriginRegistry(policy);
}

/** A promise this test resolves by hand, so two callers can be observed racing. */
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

afterEach(() => {
    delete process.env.CMS_ALLOWED_ORIGINS;
});

describe('normalizeOrigin', () => {
    it.each([
        ['https://CMS.test', 'https://cms.test'],
        ['https://cms.test/', 'https://cms.test'],
        ['https://cms.test///', 'https://cms.test'],
        ['  https://cms.test  ', 'https://cms.test'],
        ['HTTP://Localhost:5199/', 'http://localhost:5199'],
    ])('normalises %o to %o', (input, expected) => {
        // Origins compare exactly, so both sides have to be written the same
        // way. A browser sends `https://cms.test`, and an allowlist entry of
        // `https://cms.test/` would never match it.
        expect(normalizeOrigin(input)).toBe(expected);
    });

    it.each([undefined, null, '', '   ', '/'])(
        'rejects %o as no origin',
        (input) => {
            expect(normalizeOrigin(input)).toBeNull();
        }
    );
});

describe('OriginRegistry — a configured allowlist', () => {
    it('allows an origin it was given', () => {
        expect(
            build({ allowedOrigins: ['https://cms.test'] }).isAllowed(
                'https://cms.test'
            )
        ).toBe(true);
    });

    it('answers synchronously for a known origin', () => {
        // Every request after the first from a given origin must not pay for a
        // round trip; only a genuinely unknown origin does.
        const registry = build({ allowedOrigins: ['https://cms.test'] });

        expect(registry.isAllowed('https://cms.test')).not.toBeInstanceOf(
            Promise
        );
    });

    it('matches regardless of case and trailing slashes on either side', () => {
        const registry = build({ allowedOrigins: ['HTTPS://CMS.test/'] });

        expect(registry.isAllowed('https://cms.test')).toBe(true);
    });

    it('discards entries that normalise to nothing', () => {
        const registry = build({
            allowedOrigins: ['', '   ', 'https://cms.test'],
        });

        expect(registry.list()).toEqual(['https://cms.test']);
    });

    it('refuses an unknown origin when nothing can ask the user', () => {
        // A headless run cannot be talked into trusting something it was not
        // configured with.
        expect(
            build({ allowedOrigins: ['https://cms.test'] }).isAllowed(
                'https://evil.test'
            )
        ).toBe(false);
    });

    it('refuses an origin that normalises to nothing', () => {
        expect(
            build({ allowedOrigins: ['https://cms.test'] }).isAllowed('   ')
        ).toBe(false);
    });
});

describe('OriginRegistry — trust on first use', () => {
    it('asks the approver about an unknown origin', async () => {
        const approver = vi.fn().mockResolvedValue(true);
        const registry = build({ originApprover: approver });

        await expect(registry.isAllowed('https://cms.test')).resolves.toBe(
            true
        );
        expect(approver).toHaveBeenCalledWith('https://cms.test');
    });

    it('hands the approver the normalised form', () => {
        // The user is shown this string; it should not depend on how the
        // browser happened to spell the origin.
        const approver = vi.fn().mockResolvedValue(true);

        void build({ originApprover: approver }).isAllowed('HTTPS://CMS.test/');

        expect(approver).toHaveBeenCalledWith('https://cms.test');
    });

    it('remembers a grant for the life of the process', async () => {
        const approver = vi.fn().mockResolvedValue(true);
        const registry = build({ originApprover: approver });

        await registry.isAllowed('https://cms.test');

        // Synchronous now, and the user is not asked twice.
        expect(registry.isAllowed('https://cms.test')).toBe(true);
        expect(approver).toHaveBeenCalledTimes(1);
    });

    it('lists an origin granted since start-up alongside the configured ones', async () => {
        const registry = build({
            allowedOrigins: ['https://configured.test'],
            originApprover: vi.fn().mockResolvedValue(true),
        });

        await registry.isAllowed('https://granted.test');

        expect(registry.list().sort()).toEqual([
            'https://configured.test',
            'https://granted.test',
        ]);
    });

    it('does not remember a refusal as a grant', async () => {
        const approver = vi.fn().mockResolvedValue(false);
        const registry = build({ originApprover: approver });

        await expect(registry.isAllowed('https://evil.test')).resolves.toBe(
            false
        );
        expect(registry.list()).toEqual([]);
    });

    it('asks only once for two requests racing from the same origin', async () => {
        // A CMS page opening an SSE stream and posting a session in the same
        // tick produces two preflights milliseconds apart. Without the in-flight
        // map the user is shown two native dialogs for one decision.
        const gate = deferred<boolean>();
        const approver = vi.fn().mockReturnValue(gate.promise);
        const registry = build({ originApprover: approver });

        const first = registry.isAllowed('https://cms.test');
        const second = registry.isAllowed('https://cms.test');

        expect(approver).toHaveBeenCalledTimes(1);

        gate.resolve(true);
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
    });

    it('asks separately for two different origins at once', async () => {
        const approver = vi.fn().mockResolvedValue(true);
        const registry = build({ originApprover: approver });

        await Promise.all([
            registry.isAllowed('https://a.test'),
            registry.isAllowed('https://b.test'),
        ]);

        expect(approver).toHaveBeenCalledTimes(2);
    });

    it('does not ask again after a refusal', async () => {
        // A site that keeps trying would otherwise raise a dialog every few
        // seconds until someone clicked the wrong button.
        const approver = vi.fn().mockResolvedValue(false);
        const registry = build({ originApprover: approver });

        await expect(registry.isAllowed('https://cms.test')).resolves.toBe(
            false
        );
        expect(registry.isAllowed('https://cms.test')).toBe(false);
        expect(approver).toHaveBeenCalledTimes(1);
    });

    it('asks again once the refusal is revoked', async () => {
        const approver = vi
            .fn()
            .mockResolvedValueOnce(false)
            .mockResolvedValueOnce(true);
        const registry = build({ originApprover: approver });

        await registry.isAllowed('https://cms.test');
        registry.revoke('https://cms.test');

        await expect(registry.isAllowed('https://cms.test')).resolves.toBe(
            true
        );
        expect(approver).toHaveBeenCalledTimes(2);
    });

    it('treats a failed dialog as a refusal, not as consent', async () => {
        const approver = vi
            .fn()
            .mockRejectedValue(new Error('no window to attach to'));
        const registry = build({ originApprover: approver });

        await expect(registry.isAllowed('https://cms.test')).resolves.toBe(
            false
        );
        expect(registry.list()).toEqual([]);
    });

    it('does not ask about an origin already on the allowlist', () => {
        const approver = vi.fn().mockResolvedValue(true);
        const registry = build({
            allowedOrigins: ['https://cms.test'],
            originApprover: approver,
        });

        expect(registry.isAllowed('https://cms.test')).toBe(true);
        expect(approver).not.toHaveBeenCalled();
    });
});

describe('OriginRegistry — revoking a decision', () => {
    it('shuts out an origin that was allowed', () => {
        const registry = build({ allowedOrigins: ['https://cms.test'] });

        expect(registry.revoke('https://cms.test')).toBe(true);
        expect(registry.isAllowed('https://cms.test')).toBe(false);
    });

    it('takes effect at once, with no restart', () => {
        // This registry is what the CORS layer asks on every request, so there
        // is no cached copy anywhere to go stale.
        const registry = build({ allowedOrigins: ['https://cms.test'] });
        expect(registry.isAllowed('https://cms.test')).toBe(true);

        registry.revoke('https://cms.test');

        expect(registry.isAllowed('https://cms.test')).toBe(false);
    });

    it('lets a blocked site ask again', () => {
        // The case that matters: clicking "Block" on your own CMS otherwise
        // locked you out of your own encoder with no route back.
        const registry = build({
            deniedOrigins: ['https://cms.test'],
            originApprover: vi.fn().mockResolvedValue(true),
        });
        expect(registry.isAllowed('https://cms.test')).toBe(false);

        registry.revoke('https://cms.test');

        expect(registry.isAllowed('https://cms.test')).toBeInstanceOf(Promise);
    });

    it('reports whether it held anything to revoke', () => {
        const registry = build({ allowedOrigins: ['https://cms.test'] });

        expect(registry.revoke('https://other.test')).toBe(false);
        expect(registry.revoke('   ')).toBe(false);
    });

    it('normalises before looking, as everywhere else', () => {
        const registry = build({ allowedOrigins: ['https://cms.test'] });

        expect(registry.revoke('HTTPS://CMS.test/')).toBe(true);
    });
});

describe('OriginRegistry — telling the host what changed', () => {
    it('reports both lists', () => {
        const registry = build({
            allowedOrigins: ['https://yes.test'],
            deniedOrigins: ['https://no.test'],
        });

        expect(registry.decisions()).toEqual({
            allowed: ['https://yes.test'],
            denied: ['https://no.test'],
        });
    });

    it('publishes a grant so the host can persist it', async () => {
        const onDecisionsChanged = vi.fn();
        const registry = build({
            originApprover: vi.fn().mockResolvedValue(true),
            onDecisionsChanged,
        });

        await registry.isAllowed('https://cms.test');

        expect(onDecisionsChanged).toHaveBeenCalledWith({
            allowed: ['https://cms.test'],
            denied: [],
        });
    });

    it('publishes a refusal too', async () => {
        const onDecisionsChanged = vi.fn();
        const registry = build({
            originApprover: vi.fn().mockResolvedValue(false),
            onDecisionsChanged,
        });

        await registry.isAllowed('https://cms.test');

        expect(onDecisionsChanged).toHaveBeenCalledWith({
            allowed: [],
            denied: ['https://cms.test'],
        });
    });

    it('publishes a revocation', () => {
        const onDecisionsChanged = vi.fn();
        const registry = build({
            allowedOrigins: ['https://cms.test'],
            onDecisionsChanged,
        });

        registry.revoke('https://cms.test');

        expect(onDecisionsChanged).toHaveBeenCalledWith({
            allowed: [],
            denied: [],
        });
    });

    it('says nothing when there was nothing to revoke', () => {
        const onDecisionsChanged = vi.fn();
        const registry = build({ onDecisionsChanged });

        registry.revoke('https://nobody.test');

        expect(onDecisionsChanged).not.toHaveBeenCalled();
    });

    it('moves an origin out of denied when it is later allowed', () => {
        const onDecisionsChanged = vi.fn();
        const registry = build({
            deniedOrigins: ['https://cms.test'],
            onDecisionsChanged,
        });

        registry.approve('https://cms.test');

        expect(registry.decisions()).toEqual({
            allowed: ['https://cms.test'],
            denied: [],
        });
    });
});

describe('OriginRegistry — approve()', () => {
    it('adds an origin without asking anyone', () => {
        const registry = build();
        registry.approve('https://cms.test/');

        expect(registry.isAllowed('https://cms.test')).toBe(true);
    });

    it('ignores something that is not an origin', () => {
        const registry = build();
        registry.approve('   ');

        expect(registry.list()).toEqual([]);
    });
});

describe('createOriginPolicyProvider', () => {
    function resolve(
        provider: ReturnType<typeof createOriginPolicyProvider>
    ): OriginPolicy {
        return (provider as { useFactory: () => OriginPolicy }).useFactory();
    }

    it('reads CMS_ALLOWED_ORIGINS at module init, not at import', () => {
        // The factory runs after dotenv has loaded; reading at import time would
        // pin whatever the environment held before the file was parsed.
        const provider = createOriginPolicyProvider();
        process.env.CMS_ALLOWED_ORIGINS = 'https://a.test, https://b.test/';

        expect(resolve(provider).allowedOrigins).toEqual([
            'https://a.test',
            'https://b.test',
        ]);
    });

    it('yields an empty allowlist when the variable is unset', () => {
        expect(resolve(createOriginPolicyProvider()).allowedOrigins).toEqual(
            []
        );
    });

    it('drops empty entries from a trailing or doubled comma', () => {
        process.env.CMS_ALLOWED_ORIGINS = 'https://a.test,,';

        expect(resolve(createOriginPolicyProvider()).allowedOrigins).toEqual([
            'https://a.test',
        ]);
    });

    it('installs no approver by default', () => {
        expect(
            resolve(createOriginPolicyProvider()).originApprover
        ).toBeUndefined();
    });

    it('lets an embedding host override both', () => {
        process.env.CMS_ALLOWED_ORIGINS = 'https://ignored.test';
        const approver = vi.fn();
        const policy = {
            allowedOrigins: ['https://host.test'],
            originApprover: approver,
        };

        expect(resolve(createOriginPolicyProvider(policy))).toBe(policy);
    });
});
