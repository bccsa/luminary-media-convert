import {
    Controller,
    Post,
    Body,
    Headers,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service.js';
import { EncodingWebhookDto } from './dto/encoding-webhook.dto.js';
import { AuthorizeRequestDto } from './dto/authorize-request.dto.js';
import { ValidateKeyDto } from './dto/validate-key.dto.js';

@ApiTags('Webhooks')
@Controller('saas/webhooks')
export class WebhooksController {
    constructor(private readonly webhooksService: WebhooksService) {}

    @Post('encoding')
    @HttpCode(HttpStatus.OK)
    async encoding(
        @Headers('x-session-token') token: string,
        @Body() dto: EncodingWebhookDto,
    ): Promise<{ received: true }> {
        this.webhooksService.validateWebhookToken(token);
        await this.webhooksService.processEncodingWebhook(dto);
        return { received: true };
    }

    @Post('authorize')
    @HttpCode(HttpStatus.OK)
    async authorize(
        @Body() dto: AuthorizeRequestDto,
    ): Promise<{ allowed: boolean; reason?: string }> {
        return this.webhooksService.checkAuthorization(dto);
    }

    @Post('validate-key')
    @HttpCode(HttpStatus.OK)
    async validateKey(
        @Body() dto: ValidateKeyDto,
    ): Promise<{ valid: boolean; metadata?: Record<string, unknown> }> {
        return this.webhooksService.validateApiKey(dto.apiKey);
    }
}
