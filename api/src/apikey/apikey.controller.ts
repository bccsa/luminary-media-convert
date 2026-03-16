import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Param,
    Post,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBearerAuth,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ApiKeyService } from './apikey.service.js';
import { CreateApiKeyDto } from './dto/create-key.dto.js';
import {
    ApiKeyResponseDto,
    ApiKeyCreatedResponseDto,
} from './dto/key-response.dto.js';

@ApiTags('API Keys')
@Controller('api/keys')
export class ApiKeyController {
    constructor(private readonly apiKeyService: ApiKeyService) {}

    @Post()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('oidc')
    @ApiOperation({
        summary: 'Create a new API key',
        description:
            'Generates a new API key. The full key is returned only once in the response — store it securely.',
    })
    @ApiResponse({
        status: 201,
        description: 'API key created.',
        type: ApiKeyCreatedResponseDto,
    })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    createKey(@Body() dto: CreateApiKeyDto): ApiKeyCreatedResponseDto {
        const { key, record } = this.apiKeyService.create(dto);

        return {
            id: record.id,
            name: record.name,
            keyPrefix: record.keyPrefix,
            webhookUrl: record.webhookUrl,
            authorizationUrl: record.authorizationUrl,
            createdAt: record.createdAt.toISOString(),
            expiresAt: record.expiresAt?.toISOString(),
            key,
        };
    }

    @Get()
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('oidc')
    @ApiOperation({
        summary: 'List all API keys',
        description: 'Returns all active (non-revoked) API keys.',
    })
    @ApiResponse({
        status: 200,
        description: 'List of API keys.',
        type: [ApiKeyResponseDto],
    })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    listKeys(): ApiKeyResponseDto[] {
        return this.apiKeyService.findAll().map((r) => ({
            id: r.id,
            name: r.name,
            keyPrefix: r.keyPrefix,
            webhookUrl: r.webhookUrl,
            authorizationUrl: r.authorizationUrl,
            createdAt: r.createdAt.toISOString(),
            lastUsedAt: r.lastUsedAt?.toISOString(),
            expiresAt: r.expiresAt?.toISOString(),
        }));
    }

    @Delete(':keyId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth('oidc')
    @ApiOperation({
        summary: 'Revoke an API key',
        description: 'Revokes the specified API key. It can no longer be used for authentication.',
    })
    @ApiParam({ name: 'keyId', description: 'API key ID to revoke.' })
    @ApiResponse({ status: 204, description: 'API key revoked.' })
    @ApiResponse({ status: 401, description: 'Unauthorized.' })
    @ApiResponse({ status: 404, description: 'API key not found.' })
    revokeKey(@Param('keyId') keyId: string): void {
        const revoked = this.apiKeyService.revoke(keyId);
        if (!revoked) {
            throw new NotFoundException(`API key ${keyId} not found`);
        }
    }
}
