import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsUrl, IsObject, IsDateString } from 'class-validator';

export class CreateApiKeyDto {
    @ApiProperty({ description: 'Name/label for the API key.', example: 'Production' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiPropertyOptional({ description: 'Webhook URL for session lifecycle events.', example: 'https://example.com/webhooks' })
    @IsOptional()
    @IsUrl()
    webhookUrl?: string;

    @ApiPropertyOptional({ description: 'Authorization webhook URL called before session creation and encode start.' })
    @IsOptional()
    @IsUrl()
    authorizationUrl?: string;

    @ApiPropertyOptional({ description: 'Opaque metadata passed back in webhooks.' })
    @IsOptional()
    @IsObject()
    metadata?: Record<string, unknown>;

    @ApiPropertyOptional({ description: 'Expiry date (ISO 8601).', example: '2027-01-01T00:00:00Z' })
    @IsOptional()
    @IsDateString()
    expiresAt?: string;
}
