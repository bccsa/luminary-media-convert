import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    private readonly logger = new Logger(JwtStrategy.name);

    constructor() {
        const issuerUrl = process.env.OIDC_ISSUER_URL;
        const audience = process.env.OIDC_AUDIENCE;

        if (!issuerUrl || !audience) {
            throw new Error(
                'OIDC_ISSUER_URL and OIDC_AUDIENCE environment variables must be set',
            );
        }

        const issuer = issuerUrl.replace(/\/$/, '') + '/';

        super({
            secretOrKeyProvider: passportJwtSecret({
                cache: true,
                rateLimit: true,
                jwksRequestsPerMinute: 5,
                jwksUri: `${issuer}.well-known/jwks.json`,
            }),
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            audience,
            issuer,
            algorithms: ['RS256'],
        });

        this.logger.log(`OIDC JWT validation configured for issuer: ${issuer}`);
    }

    validate(payload: Record<string, unknown>): Record<string, unknown> {
        return payload;
    }
}
