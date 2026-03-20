import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SkipAdmin } from '../auth/skip-admin.decorator.js';
import { S3ConfigsService } from './s3-configs.service.js';
import { CreateS3ConfigDto } from './dto/create-s3-config.dto.js';
import { UpdateS3ConfigDto } from './dto/update-s3-config.dto.js';
import { S3ConfigResponseDto } from './dto/s3-config-response.dto.js';
import type { S3ConfigDocument } from './interfaces/s3-config-document.interface.js';
import type { UserDocument } from '../users/interfaces/user-document.interface.js';

function toListResponse(doc: S3ConfigDocument): S3ConfigResponseDto {
    return {
        id: doc._id,
        name: doc.name,
        endPoint: doc.endPoint,
        port: doc.port,
        useSSL: doc.useSSL,
        bucket: doc.bucket,
        region: doc.region,
        pathPrefix: doc.pathPrefix,
        accessKey: '***',
        secretKey: '***',
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

@ApiTags('S3 Configs')
@ApiBearerAuth('auth0')
@Controller('saas/s3-configs')
@UseGuards(JwtAuthGuard)
@SkipAdmin()
export class S3ConfigsController {
    constructor(private readonly s3ConfigsService: S3ConfigsService) {}

    @Post()
    async create(
        @Body() dto: CreateS3ConfigDto,
        @Req() req: { user: UserDocument },
    ): Promise<S3ConfigResponseDto> {
        const doc = await this.s3ConfigsService.create(req.user._id, dto);
        return toListResponse(doc);
    }

    @Get()
    async list(
        @Req() req: { user: UserDocument },
    ): Promise<{ configs: S3ConfigResponseDto[] }> {
        const docs = await this.s3ConfigsService.list(req.user._id);
        return { configs: docs.map(toListResponse) };
    }

    @Get(':configId')
    async detail(
        @Param('configId') configId: string,
        @Req() req: { user: UserDocument },
    ): Promise<S3ConfigResponseDto> {
        const doc = await this.s3ConfigsService.getById(req.user._id, configId);
        const creds = this.s3ConfigsService.decryptCredentials(doc);
        return {
            id: doc._id,
            name: doc.name,
            endPoint: doc.endPoint,
            port: doc.port,
            useSSL: doc.useSSL,
            bucket: doc.bucket,
            region: doc.region,
            pathPrefix: doc.pathPrefix,
            accessKey: creds.accessKey,
            secretKey: creds.secretKey,
            createdAt: doc.createdAt,
            updatedAt: doc.updatedAt,
        };
    }

    @Patch(':configId')
    async update(
        @Param('configId') configId: string,
        @Body() dto: UpdateS3ConfigDto,
        @Req() req: { user: UserDocument },
    ): Promise<S3ConfigResponseDto> {
        const doc = await this.s3ConfigsService.update(
            req.user._id,
            configId,
            dto,
        );
        return toListResponse(doc);
    }

    @Delete(':configId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(
        @Param('configId') configId: string,
        @Req() req: { user: UserDocument },
    ): Promise<void> {
        await this.s3ConfigsService.remove(req.user._id, configId);
    }
}
