import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiKeyResponseDto {
    @ApiProperty() id: string;
    @ApiProperty() name: string;
    @ApiProperty({ example: 'lmc_a1b2c3d4' }) keyPrefix: string;
    @ApiPropertyOptional() webhookUrl?: string;
    @ApiPropertyOptional() authorizationUrl?: string;
    @ApiProperty() createdAt: string;
    @ApiPropertyOptional() lastUsedAt?: string;
    @ApiPropertyOptional() expiresAt?: string;
}

export class ApiKeyCreatedResponseDto extends ApiKeyResponseDto {
    @ApiProperty({ description: 'Full API key. Shown only once — store it securely.' })
    key: string;
}
