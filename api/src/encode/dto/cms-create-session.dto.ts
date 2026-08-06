import {
    IsBoolean,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    IsUrl,
    Max,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from './s3-config.dto.js';

/**
 * Whether the CMS wants the output encrypted.
 *
 * Deliberately not {@link EncryptionConfigDto}: a CMS states a requirement, it
 * does not configure key delivery. The key URI is always the local placeholder
 * and the key itself reaches the CMS over SSE, so there is nothing else to say.
 */
export class CmsEncryptionRequirementDto {
    @ApiProperty({
        description:
            'Encrypt the HLS output with AES-128. The key hex is delivered to the ' +
            'CMS over SSE when encoding starts.',
        example: true,
    })
    @IsBoolean()
    @Expose()
    required: boolean;
}

/**
 * Media the post already has.
 *
 * Accepted and stored so the CMS can send it today and get edit mode when it
 * lands; nothing acts on it yet. Validated all the same — a shape that was
 * never checked is a shape that will be wrong by the time something reads it.
 */
export class CmsExistingMediaDto {
    @ApiProperty({
        description: 'Public URL of the master playlist already attached to the post.',
        example: 'https://cdn.example.com/media/abc123/master.m3u8',
    })
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
    @MaxLength(2048)
    @Expose()
    hlsUrl: string;

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 key for the existing output, when it was encrypted.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    @Expose()
    hlsKey?: string;
}

/**
 * What the Luminary CMS sends when a user clicks "upload / edit media" on a post.
 *
 * The CMS supplies everything about the destination — credentials, where the
 * output is published from, what the post is called — and the local app supplies
 * the file and the encode settings. Nothing in here is echoed back: the response
 * carries identifiers and a read token, never the storage credentials.
 */
export class CmsCreateSessionDto {
    @ApiProperty({
        description:
            'The CMS document this media belongs to. Used to recognise a repeat ' +
            'click on the same post and hand back the session already in flight.',
        example: 'post_01HTZ8Y0J4',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    @Expose()
    documentId: string;

    @ApiProperty({
        description: 'Post title, shown in the local app so the user can tell sessions apart.',
        example: 'Episode 12 — The Long Way Round',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(512)
    @Expose()
    title: string;

    @ApiProperty({
        description: 'S3-compatible storage the encoded output is written to.',
        type: S3ConfigDto,
    })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiProperty({
        description:
            'Public base URL the bucket is served from. The final playback URL is this ' +
            'joined with the session\'s object key, and is reported to the CMS over SSE ' +
            'as soon as encoding starts.',
        example: 'https://cdn.example.com/media',
    })
    @IsUrl({ protocols: ['http', 'https'], require_protocol: true, require_tld: false })
    @MaxLength(2048)
    @Expose()
    publicBaseUrl: string;

    @ApiPropertyOptional({
        description: 'Whether the output must be encrypted. Omitted means unencrypted.',
        type: CmsEncryptionRequirementDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => CmsEncryptionRequirementDto)
    @Expose()
    encryption?: CmsEncryptionRequirementDto;

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
            'Generate WebVTT thumbnail sprites for scrubbing preview. Only applies to video encodes. Defaults to true.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    thumbnails?: boolean;

    @ApiPropertyOptional({
        description:
            'Media already attached to the post. Stored for a future edit mode; ' +
            'nothing acts on it today.',
        type: CmsExistingMediaDto,
    })
    @IsOptional()
    @ValidateNested()
    @Type(() => CmsExistingMediaDto)
    @Expose()
    existingMedia?: CmsExistingMediaDto;
}
