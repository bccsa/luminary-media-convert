import { IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';

export class HlsChaptersReadRequestDto {
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

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 session key, for sessions created with ' +
            '`encryption.encryptPlaylists`. Objects that carry the LMCENC01 ' +
            'magic are decrypted with it before parsing, and anything written ' +
            'back is re-encrypted with a fresh IV — plaintext is never stored. ' +
            'Plaintext objects are read as-is whether or not this is supplied.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @Matches(/^[0-9a-fA-F]{32}$/, {
        message: 'keyHex must be 32 hex characters (an AES-128 key)',
    })
    @IsOptional()
    @Expose()
    keyHex?: string;
}

export interface HlsChaptersReadResult {
    /** WebVTT body. */
    vtt: string;
}
