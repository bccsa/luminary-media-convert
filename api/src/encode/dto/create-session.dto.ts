import {
    IsBoolean,
    IsNumber,
    IsOptional,
    Max,
    Min,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from './s3-config.dto.js';
import { EncryptionConfigDto } from './encryption-config.dto.js';

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

    @ApiPropertyOptional({
        description:
            'Use byte-range HLS segments (one file per rendition, split if exceeding max file size). Defaults to true.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    byteRange?: boolean;

    @ApiPropertyOptional({
        description:
            'Max byte-range output file size in MB. Varies by storage provider / CDN. Defaults to 500.',
        default: 500,
        example: 500,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Max(10240)
    @Expose()
    byteRangeMaxFileSizeMB?: number;

    @ApiPropertyOptional({
        description:
            'Max size in MB of a byte-range file in the audio chain. The audio chain ' +
            'carries every audio rendition of the encode, so the timeline a chunk ' +
            'covers is cap / (audio stream count x bytes per minute per stream): ' +
            '50 MB over 3 stereo streams at ~1.4 MB/min is around 12 minutes, and ' +
            'over a 15-stream multi-language ladder around 2. Raise it for a wide ' +
            'ladder, or its boundaries come round several times an hour. Defaults to 50.',
        default: 50,
        example: 50,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    audioByteRangeMaxFileSizeMB?: number;

    @ApiPropertyOptional({
        description:
            'Generate WebVTT thumbnail sprites for scrubbing preview. Only applies to video encodes. Defaults to true.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    thumbnails?: boolean;

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
            'HLS AES-128 encryption configuration. Enabled by default when provided.',
        type: EncryptionConfigDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => EncryptionConfigDto)
    @Expose()
    encryption?: EncryptionConfigDto;
}
