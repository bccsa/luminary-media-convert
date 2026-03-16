import { Injectable, UnauthorizedException } from '@nestjs/common';
import { UsersService } from '../users/users.service.js';
import { UserDocument } from '../users/interfaces/user-document.interface.js';

@Injectable()
export class IdentityService {
    constructor(private readonly usersService: UsersService) {}

    async resolveUser(payload: {
        sub: string;
        email: string;
    }): Promise<UserDocument> {
        // Fast path: lookup by auth0Id
        let user = await this.usersService.findByAuth0Id(payload.sub);

        if (!user && payload.email) {
            // Lookup by email and link auth0Id
            user = await this.usersService.findByEmail(payload.email);

            if (user) {
                await this.usersService.linkAuth0Id(
                    user._id,
                    payload.sub,
                );
                user.auth0Id = payload.sub;
            }
        }

        if (!user) {
            throw new UnauthorizedException('Account not provisioned');
        }

        if (user.status === 'disabled') {
            throw new UnauthorizedException('Account disabled');
        }

        return user;
    }
}
