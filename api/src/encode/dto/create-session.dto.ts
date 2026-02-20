import {
    IsArray,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RenditionDto } from './rendition.dto.js';
import { S3ConfigDto } from './s3-config.dto.js';
import { WebhookConfigDto } from './webhook-config.dto.js';

export class CreateSessionDto {
    @ApiProperty({
        description: 'Encoding type: video (with optional ABR) or audio-only.',
        enum: ['video', 'audio'],
        example: 'video',
    })
    @IsString()
    @IsNotEmpty()
    @IsIn(['video', 'audio'])
    @Expose()
    type: 'video' | 'audio';

    @ApiProperty({
        description:
            'Array of renditions (quality variants) to encode. For video ABR, provide multiple entries with different resolutions/bitrates. For audio-only, provide one or more entries with audio bitrates.',
        type: [RenditionDto],
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => RenditionDto)
    @Expose()
    renditions: RenditionDto[];

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

    @ApiProperty({
        description: 'Webhook configuration for status callbacks.',
        type: WebhookConfigDto,
    })
    @ValidateNested()
    @Type(() => WebhookConfigDto)
    @Expose()
    webhook: WebhookConfigDto;
}
