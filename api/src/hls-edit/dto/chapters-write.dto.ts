import { IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';

export class HlsChaptersWriteRequestDto {
    @ApiProperty({ type: S3ConfigDto })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiProperty({
        description:
            'Folder prefix containing the HLS output. Trailing slash optional.',
    })
    @IsString()
    @Expose()
    folderPrefix: string;

    @ApiProperty({
        description: 'BCP-47 language code (e.g. `en`, `en-US`).',
        example: 'en',
    })
    @Matches(/^[a-z]{2,3}(?:-[A-Z]{2})?$/, {
        message: 'lang must be a BCP-47 language code',
    })
    @Expose()
    lang: string;

    @ApiProperty({
        description:
            'WebVTT chapter document. Must start with `WEBVTT`. Max 1 MiB.',
    })
    @IsString()
    @Expose()
    vtt: string;

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 session key, for sessions created with ' +
            '`encryption.encryptPlaylists`. Supplying it means this session\'s ' +
            'sidecars are encrypted: the body is stored as LMCENC01 with a ' +
            'fresh IV and Content-Type: application/octet-stream. `vtt` itself ' +
            'is always sent as plaintext WebVTT.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @Matches(/^[0-9a-fA-F]{32}$/, {
        message: 'keyHex must be 32 hex characters (an AES-128 key)',
    })
    @IsOptional()
    @Expose()
    keyHex?: string;
}
