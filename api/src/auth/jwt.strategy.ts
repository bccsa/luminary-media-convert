import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    private readonly logger = new Logger(JwtStrategy.name);

    constructor() {
        const domain = process.env.AUTH0_DOMAIN;
        const audience = process.env.AUTH0_AUDIENCE;

        if (!domain || !audience) {
            throw new Error(
                'AUTH0_DOMAIN and AUTH0_AUDIENCE environment variables must be set',
            );
        }

        super({
            secretOrKeyProvider: passportJwtSecret({
                cache: true,
                rateLimit: true,
                jwksRequestsPerMinute: 5,
                jwksUri: `https://${domain}/.well-known/jwks.json`,
            }),
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            audience,
            issuer: `https://${domain}/`,
            algorithms: ['RS256'],
        });

        this.logger.log(`Auth0 JWT validation configured for domain: ${domain}`);
    }

    validate(payload: Record<string, unknown>): Record<string, unknown> {
        return payload;
    }
}
