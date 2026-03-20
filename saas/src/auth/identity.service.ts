import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { UserDocument } from '../users/interfaces/user-document.interface.js';

@Injectable()
export class IdentityService {
    private readonly logger = new Logger(IdentityService.name);

    constructor(private readonly usersService: UsersService) {}

    async resolveUser(payload: {
        sub: string;
        email: string;
    }): Promise<UserDocument> {
        this.logger.debug(
            `Resolving user: sub=${payload.sub}, email=${payload.email ?? '(none)'}`,
        );

        // Fast path: lookup by auth0Id
        let user = await this.usersService.findByAuth0Id(payload.sub);
        this.logger.debug(
            `findByAuth0Id(${payload.sub}): ${user ? `found ${user._id}` : 'not found'}`,
        );

        if (!user && payload.email) {
            // Lookup by email and link auth0Id
            user = await this.usersService.findByEmail(payload.email);
            this.logger.debug(
                `findByEmail(${payload.email}): ${user ? `found ${user._id}` : 'not found'}`,
            );

            if (user) {
                await this.usersService.linkAuth0Id(
                    user._id,
                    payload.sub,
                );
                user.auth0Id = payload.sub;
                this.logger.log(
                    `Linked auth0Id ${payload.sub} to user ${user._id}`,
                );
            }
        } else if (!user) {
            this.logger.warn(
                'No email in JWT payload — cannot attempt email-based lookup',
            );
        }

        if (!user) {
            this.logger.warn(
                `Account not provisioned: sub=${payload.sub}, email=${payload.email ?? '(none)'}`,
            );
            throw new UnauthorizedException('Account not provisioned');
        }

        if (user.status === 'disabled') {
            this.logger.warn(`Account disabled: ${user._id}`);
            throw new UnauthorizedException('Account disabled');
        }

        this.logger.debug(`Resolved user ${user._id} (role=${user.role})`);

        // Update lastLoginAt (fire-and-forget — upsert handles conflicts)
        this.usersService
            .update(user._id, { lastLoginAt: new Date().toISOString() } as Partial<UserDocument>)
            .catch((err) =>
                this.logger.warn(`Failed to update lastLoginAt for ${user._id}: ${err}`),
            );

        return user;
    }
}
