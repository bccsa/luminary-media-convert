import {
    IsNotEmpty,
    IsOptional,
    IsString,
    Matches,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';

export class HlsReadRequestDto {
    @ApiProperty({
        type: S3ConfigDto,
        description: 'Inline S3 credentials for the target bucket.',
    })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiProperty({
        description:
            'S3 key of the master playlist, or a full URL that contains it.',
        example: 'videos/session-abc/master.m3u8',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    masterPlaylistKey: string;

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
