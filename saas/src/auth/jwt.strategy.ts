import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, ExtractJwt } from 'passport-jwt';
import { passportJwtSecret } from 'jwks-rsa';
import { IdentityService } from './identity.service.js';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
    private readonly logger = new Logger(JwtStrategy.name);

    constructor(private readonly identityService: IdentityService) {
        const domain = process.env.AUTH0_DOMAIN;
        const audience = process.env.AUTH0_AUDIENCE;

        if (!domain || !audience) {
            throw new Error(
                'AUTH0_DOMAIN and AUTH0_AUDIENCE environment variables must be set',
            );
        }

        const issuer = `https://${domain}/`;

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

        this.logger.log(
            `Auth0 JWT validation configured for domain: ${domain}`,
        );
    }

    async validate(
        payload: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
        const sub = payload.sub as string;
        const email = (payload.email ||
            payload[`https://${process.env.AUTH0_DOMAIN}/email`]) as string;

        const user = await this.identityService.resolveUser({ sub, email });

        return { ...payload, ...user };
    }
}
