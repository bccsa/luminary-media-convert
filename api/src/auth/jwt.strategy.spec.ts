import { JwtStrategy } from './jwt.strategy.js';

describe('JwtStrategy', () => {
    const savedIssuerUrl = process.env.OIDC_ISSUER_URL;
    const savedAudience = process.env.OIDC_AUDIENCE;

    afterEach(() => {
        process.env.OIDC_ISSUER_URL = savedIssuerUrl;
        process.env.OIDC_AUDIENCE = savedAudience;
    });

    it('should throw when OIDC_ISSUER_URL is missing', () => {
        delete process.env.OIDC_ISSUER_URL;
        process.env.OIDC_AUDIENCE = 'https://api.example.com';

        expect(() => new JwtStrategy()).toThrow(
            'OIDC_ISSUER_URL and OIDC_AUDIENCE environment variables must be set',
        );
    });

    it('should throw when OIDC_AUDIENCE is missing', () => {
        process.env.OIDC_ISSUER_URL = 'https://example.auth0.com/';
        delete process.env.OIDC_AUDIENCE;

        expect(() => new JwtStrategy()).toThrow(
            'OIDC_ISSUER_URL and OIDC_AUDIENCE environment variables must be set',
        );
    });

    it('should throw when both env vars are missing', () => {
        delete process.env.OIDC_ISSUER_URL;
        delete process.env.OIDC_AUDIENCE;

        expect(() => new JwtStrategy()).toThrow(
            'OIDC_ISSUER_URL and OIDC_AUDIENCE environment variables must be set',
        );
    });

    it('should construct successfully when both env vars are set', () => {
        process.env.OIDC_ISSUER_URL = 'https://example.auth0.com/';
        process.env.OIDC_AUDIENCE = 'https://api.example.com';

        expect(() => new JwtStrategy()).not.toThrow();
    });

    it('should normalize issuer URL with trailing slash', () => {
        process.env.OIDC_ISSUER_URL = 'https://example.auth0.com';
        process.env.OIDC_AUDIENCE = 'https://api.example.com';

        expect(() => new JwtStrategy()).not.toThrow();
    });

    it('validate() should return the payload as-is', () => {
        process.env.OIDC_ISSUER_URL = 'https://example.auth0.com/';
        process.env.OIDC_AUDIENCE = 'https://api.example.com';

        const strategy = new JwtStrategy();
        const payload = { sub: 'auth0|123', iss: 'https://example.auth0.com/' };

        expect(strategy.validate(payload)).toBe(payload);
    });
});
