import {
    Controller,
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
import { SessionsService } from './sessions.service.js';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
import { SaasSessionResponseDto } from './dto/session-response.dto.js';

@ApiTags('Sessions')
@ApiBearerAuth('auth0')
@Controller('saas/sessions')
@UseGuards(JwtAuthGuard)
export class SessionsController {
    constructor(private readonly sessionsService: SessionsService) {}

    @Post()
    async create(
        @Body() dto: CreateSaasSessionDto,
        @Req() req: { user: { _id: string } },
    ): Promise<SaasSessionResponseDto> {
        return this.sessionsService.createSession(req.user._id, dto);
    }

    @Delete(':sessionId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(
        @Param('sessionId') sessionId: string,
        @Req() req: { user: { _id: string } },
    ): Promise<void> {
        await this.sessionsService.deleteSession(req.user._id, sessionId);
    }
}
