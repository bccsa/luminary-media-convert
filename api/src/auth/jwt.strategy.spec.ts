import { JwtStrategy } from './jwt.strategy.js';

describe('JwtStrategy', () => {
    const savedDomain = process.env.AUTH0_DOMAIN;
    const savedAudience = process.env.AUTH0_AUDIENCE;

    afterEach(() => {
        process.env.AUTH0_DOMAIN = savedDomain;
        process.env.AUTH0_AUDIENCE = savedAudience;
    });

    it('should throw when AUTH0_DOMAIN is missing', () => {
        delete process.env.AUTH0_DOMAIN;
        process.env.AUTH0_AUDIENCE = 'https://api.example.com';

        expect(() => new JwtStrategy()).toThrow(
            'AUTH0_DOMAIN and AUTH0_AUDIENCE environment variables must be set',
        );
    });

    it('should throw when AUTH0_AUDIENCE is missing', () => {
        process.env.AUTH0_DOMAIN = 'example.auth0.com';
        delete process.env.AUTH0_AUDIENCE;

        expect(() => new JwtStrategy()).toThrow(
            'AUTH0_DOMAIN and AUTH0_AUDIENCE environment variables must be set',
        );
    });

    it('should throw when both env vars are missing', () => {
        delete process.env.AUTH0_DOMAIN;
        delete process.env.AUTH0_AUDIENCE;

        expect(() => new JwtStrategy()).toThrow(
            'AUTH0_DOMAIN and AUTH0_AUDIENCE environment variables must be set',
        );
    });

    it('should construct successfully when both env vars are set', () => {
        process.env.AUTH0_DOMAIN = 'example.auth0.com';
        process.env.AUTH0_AUDIENCE = 'https://api.example.com';

        expect(() => new JwtStrategy()).not.toThrow();
    });

    it('validate() should return the payload as-is', () => {
        process.env.AUTH0_DOMAIN = 'example.auth0.com';
        process.env.AUTH0_AUDIENCE = 'https://api.example.com';

        const strategy = new JwtStrategy();
        const payload = { sub: 'auth0|123', iss: 'https://example.auth0.com/' };

        expect(strategy.validate(payload)).toBe(payload);
    });
});
