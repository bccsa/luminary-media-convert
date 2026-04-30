import {
    Controller,
    Get,
    Delete,
    Param,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AdminGuard } from '../auth/admin.guard.js';
import { KeysService } from './keys.service.js';
import { KeyResponseDto } from './dto/key-response.dto.js';

@ApiTags('Admin - API Keys')
@ApiBearerAuth('auth0')
@Controller('saas/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminKeysController {
    constructor(private readonly keysService: KeysService) {}

    @Get('users/:userId/keys')
    async listUserKeys(
        @Param('userId') userId: string,
    ): Promise<KeyResponseDto[]> {
        const docs = await this.keysService.listKeysByUserId(userId);

        return docs.map((doc) => ({
            id: doc._id,
            name: doc.name,
            prefix: doc.prefix,
            status: doc.status,
            lastUsedAt: doc.lastUsedAt,
            createdAt: doc.createdAt,
        }));
    }

    @Delete('users/:userId/keys/:keyId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async revokeUserKey(
        @Param('userId') _userId: string,
        @Param('keyId') keyId: string,
    ): Promise<void> {
        await this.keysService.adminRevokeKey(keyId);
    }
}
