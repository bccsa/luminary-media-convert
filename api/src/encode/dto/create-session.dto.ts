import {
    IsNumber,
    IsOptional,
    Min,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from './s3-config.dto.js';
import { WebhookConfigDto } from './webhook-config.dto.js';

export class CreateSessionDto {
    @ApiPropertyOptional({
        description: 'HLS segment duration in seconds. Defaults to 6.',
        default: 6,
        example: 6,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    segmentDuration?: number;

    @ApiProperty({
        description: 'S3-compatible storage configuration for output files.',
        type: S3ConfigDto,
    })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiPropertyOptional({
        description:
            'Webhook configuration for status callbacks. If omitted, no webhooks are sent — use the polling endpoint instead.',
        type: WebhookConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => WebhookConfigDto)
    @Expose()
    webhook?: WebhookConfigDto;
}
