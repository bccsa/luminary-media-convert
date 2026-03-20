import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SkipAdmin } from '../auth/skip-admin.decorator.js';
import { KeysService } from './keys.service.js';
import { CreateKeyDto } from './dto/create-key.dto.js';
import { KeyResponseDto } from './dto/key-response.dto.js';

@ApiTags('API Keys')
@ApiBearerAuth('auth0')
@Controller('saas/keys')
@UseGuards(JwtAuthGuard)
@SkipAdmin()
export class KeysController {
    constructor(private readonly keysService: KeysService) {}

    @Post()
    async create(
        @Body() dto: CreateKeyDto,
        @Req() req: { user: { _id: string } },
    ): Promise<KeyResponseDto> {
        const doc = await this.keysService.createKey(
            req.user._id,
            dto.name,
            dto.keyHash,
            dto.prefix,
        );

        return {
            id: doc._id,
            name: doc.name,
            prefix: doc.prefix,
            status: doc.status,
            lastUsedAt: doc.lastUsedAt,
            createdAt: doc.createdAt,
        };
    }

    @Get()
    async list(
        @Req() req: { user: { _id: string } },
    ): Promise<KeyResponseDto[]> {
        const docs = await this.keysService.listKeys(req.user._id);

        return docs.map((doc) => ({
            id: doc._id,
            name: doc.name,
            prefix: doc.prefix,
            status: doc.status,
            lastUsedAt: doc.lastUsedAt,
            createdAt: doc.createdAt,
        }));
    }

    @Delete(':keyId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async revoke(
        @Param('keyId') keyId: string,
        @Req() req: { user: { _id: string } },
    ): Promise<void> {
        await this.keysService.revokeKey(req.user._id, keyId);
    }
}
