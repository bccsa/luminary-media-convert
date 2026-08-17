import {
    ArrayMinSize,
    IsArray,
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';

/**
 * Single mutation operation on a master playlist. Operations are dispatched
 * by `type`; unknown types cause the request to be rejected. Specific
 * operation bodies are implemented in follow-up PRs.
 */
export class HlsOperationDto {
    @ApiProperty({
        description: 'Operation discriminator.',
        enum: [
            'upsertSubtitle',
            'removeSubtitle',
            'upsertChapters',
            'removeChapters',
        ],
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    type: string;

    @ApiPropertyOptional({
        description: 'BCP-47 or ISO-639 language tag (subtitles).',
    })
    @IsString()
    @IsOptional()
    @Expose()
    language?: string;

    @ApiPropertyOptional({ description: 'Display name (subtitles).' })
    @IsString()
    @IsOptional()
    @Expose()
    name?: string;

    @ApiPropertyOptional({
        description: 'Base64-encoded WebVTT content (upsert operations).',
    })
    @IsString()
    @IsOptional()
    @Expose()
    vttBase64?: string;

    @ApiPropertyOptional({ description: 'Mark this subtitle as DEFAULT=YES.' })
    @IsOptional()
    @Expose()
    default?: boolean;

    @ApiPropertyOptional({ description: 'Mark this subtitle as FORCED=YES.' })
    @IsOptional()
    @Expose()
    forced?: boolean;
}

export class HlsMutateRequestDto {
    @ApiProperty({ type: S3ConfigDto })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiProperty({
        description: 'S3 key of the master playlist (or a full URL).',
        example: 'videos/session-abc/master.m3u8',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    masterPlaylistKey: string;

    @ApiProperty({
        description:
            'ETag returned from /api/hls/read. Sent as If-Match on the write.',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    ifMatch: string;

    @ApiProperty({
        type: [HlsOperationDto],
        description:
            'Ordered list of operations. An empty array is a no-op that still rewrites master.m3u8 (useful for ETag plumbing verification).',
    })
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => HlsOperationDto)
    @Expose()
    operations: HlsOperationDto[];

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 session key, for sessions created with ' +
            '`encryption.encryptPlaylists`. An LMCENC01 master is decrypted ' +
            'with it before parsing, and the rewritten master is re-encrypted ' +
            'with a fresh IV — plaintext never reaches the bucket.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @Matches(/^[0-9a-fA-F]{32}$/, {
        message: 'keyHex must be 32 hex characters (an AES-128 key)',
    })
    @IsOptional()
    @Expose()
    keyHex?: string;
}
