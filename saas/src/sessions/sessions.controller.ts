import {
    Controller,
    Get,
    Post,
    Put,
    Patch,
    Delete,
    Body,
    Param,
    Query,
    Req,
    UseGuards,
    HttpCode,
    HttpStatus,
    NotFoundException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { SkipAdmin } from '../auth/skip-admin.decorator.js';
import { SessionsService } from './sessions.service.js';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
import { UrlUploadDto } from './dto/url-upload.dto.js';
import { ImportSessionDto } from './dto/import-session.dto.js';
import { MoveSessionFilesDto } from './dto/move-session-files.dto.js';
import { RenameSessionPrefixDto } from './dto/rename-session-prefix.dto.js';
import { SaasSessionResponseDto } from './dto/session-response.dto.js';

@ApiTags('Sessions')
@ApiBearerAuth('auth0')
@Controller('saas/sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
    constructor(
        private readonly sessionsService: SessionsService,
    ) {}

    @Post('import')
    @SkipAdmin()
    async importSession(
        @Body() dto: ImportSessionDto,
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.importSession(req.user._id, dto);
    }

    @Post()
    async create(
        @Body() dto: CreateSaasSessionDto,
        @Req() req: { user: { _id: string } },
    ): Promise<SaasSessionResponseDto> {
        return this.sessionsService.createSession(req.user._id, dto);
    }

    @Post(':sessionId/url-upload')
    @SkipAdmin()
    @HttpCode(HttpStatus.ACCEPTED)
    async startUrlUpload(
        @Param('sessionId') sessionId: string,
        @Body() dto: UrlUploadDto,
        @Req() req: { user: { _id: string } },
    ): Promise<{ sessionId: string; status: 'uploading' }> {
        return this.sessionsService.startUrlUpload(req.user._id, sessionId, dto);
    }

    @Get()
    @ApiQuery({ name: 'limit', required: false, type: Number })
    @ApiQuery({ name: 'skip', required: false, type: Number })
    @ApiQuery({ name: 'status', required: false, type: String })
    @ApiQuery({ name: 'name', required: false, type: String })
    async list(
        @Req() req: { user: { _id: string } },
        @Query('limit') limit?: number,
        @Query('skip') skip?: number,
        @Query('status') status?: string,
        @Query('name') name?: string,
    ) {
        return this.sessionsService.listSessions(req.user._id, {
            limit,
            skip,
            status,
            name,
        });
    }

    @Patch(':sessionId/name')
    @SkipAdmin()
    async updateName(
        @Param('sessionId') sessionId: string,
        @Body() body: { name: string },
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.updateSessionName(
            req.user._id,
            sessionId,
            body.name ?? '',
        );
    }

    @Post(':sessionId/move')
    @SkipAdmin()
    async moveFiles(
        @Param('sessionId') sessionId: string,
        @Body() dto: MoveSessionFilesDto,
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.moveSessionFiles(req.user._id, sessionId, dto);
    }

    @Post(':sessionId/hls/read')
    @SkipAdmin()
    @HttpCode(HttpStatus.OK)
    async hlsRead(
        @Param('sessionId') sessionId: string,
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.hlsRead(req.user._id, sessionId);
    }

    @Post(':sessionId/hls/mutate')
    @SkipAdmin()
    @HttpCode(HttpStatus.OK)
    async hlsMutate(
        @Param('sessionId') sessionId: string,
        @Body() body: { ifMatch: string; operations: Array<{ type: string } & Record<string, unknown>> },
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.hlsMutate(
            req.user._id,
            sessionId,
            body.ifMatch,
            body.operations ?? [],
        );
    }

    @Get(':sessionId/chapters')
    @SkipAdmin()
    @ApiQuery({ name: 'lang', required: false, type: String, description: 'BCP-47 language code (default `en`)' })
    async readChapters(
        @Param('sessionId') sessionId: string,
        @Query('lang') lang: string | undefined,
        @Req() req: { user: { _id: string } },
    ): Promise<{ vtt: string }> {
        const result = await this.sessionsService.readChapters(
            req.user._id,
            sessionId,
            lang ?? 'en',
        );
        if (!result) throw new NotFoundException('No chapter file for this language');
        return result;
    }

    @Put(':sessionId/chapters')
    @SkipAdmin()
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiQuery({ name: 'lang', required: false, type: String, description: 'BCP-47 language code (default `en`)' })
    async writeChapters(
        @Param('sessionId') sessionId: string,
        @Query('lang') lang: string | undefined,
        @Body() body: { vtt: string },
        @Req() req: { user: { _id: string } },
    ): Promise<void> {
        await this.sessionsService.writeChapters(
            req.user._id,
            sessionId,
            lang ?? 'en',
            body?.vtt ?? '',
        );
    }

    @Post(':sessionId/rename-prefix')
    @SkipAdmin()
    async renamePrefix(
        @Param('sessionId') sessionId: string,
        @Body() dto: RenameSessionPrefixDto,
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.renameSessionPrefix(req.user._id, sessionId, dto);
    }

    @Get('check-prefix')
    @SkipAdmin()
    @ApiQuery({ name: 's3ConfigId', required: true, type: String })
    @ApiQuery({ name: 'prefix', required: true, type: String })
    async checkPrefix(
        @Query('s3ConfigId') s3ConfigId: string,
        @Query('prefix') prefix: string,
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.checkPrefix(req.user._id, s3ConfigId, prefix);
    }

    @Get(':sessionId')
    async detail(
        @Param('sessionId') sessionId: string,
        @Req() req: { user: { _id: string } },
    ) {
        return this.sessionsService.getSession(req.user._id, sessionId);
    }

    @Delete(':sessionId')
    @HttpCode(HttpStatus.NO_CONTENT)
    @ApiQuery({ name: 'deleteFiles', required: false, type: Boolean, description: 'Also delete S3 files' })
    async remove(
        @Param('sessionId') sessionId: string,
        @Query('deleteFiles') deleteFiles: string | boolean | undefined,
        @Req() req: { user: { _id: string } },
    ): Promise<void> {
        const shouldDeleteFiles = deleteFiles === true || deleteFiles === 'true';
        await this.sessionsService.deleteSession(req.user._id, sessionId, shouldDeleteFiles);
    }
}
