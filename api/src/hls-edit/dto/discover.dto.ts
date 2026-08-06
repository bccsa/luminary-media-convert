import { IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';

export class HlsDiscoverRequestDto {
    @ApiProperty({ type: S3ConfigDto })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiPropertyOptional({
        description:
            'Folder prefix (or full URL) to scan. Mutually usable with masterPlaylistKey — if it ends with .m3u8, the enclosing folder is scanned.',
    })
    @IsString()
    @IsOptional()
    @Expose()
    folderPrefix?: string;

    @ApiPropertyOptional({
        description:
            'A specific master playlist key; its enclosing folder is scanned.',
    })
    @IsString()
    @IsOptional()
    @Expose()
    masterPlaylistKey?: string;

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 session key, for sessions created with ' +
            '`encryption.encryptPlaylists`. Without it an encrypted output ' +
            'looks like a folder with no masters in it — the scan cannot see ' +
            '#EXT-X-STREAM-INF through the ciphertext.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @Matches(/^[0-9a-fA-F]{32}$/, {
        message: 'keyHex must be 32 hex characters (an AES-128 key)',
    })
    @IsOptional()
    @Expose()
    keyHex?: string;
}
