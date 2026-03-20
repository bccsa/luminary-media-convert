import { IsOptional, IsString, IsHexadecimal, Length } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ImportSessionDto {
    @ApiProperty({ description: 'ID of the saved S3 config to use' })
    @IsString()
    @Expose()
    s3ConfigId: string;

    @ApiPropertyOptional({
        description:
            'Full S3 key of the master playlist (e.g. "output/master.m3u8")',
    })
    @IsString()
    @IsOptional()
    @Expose()
    masterPlaylistKey?: string;

    @ApiPropertyOptional({
        description:
            'S3 key prefix to search for HLS files (e.g. "output/")',
    })
    @IsString()
    @IsOptional()
    @Expose()
    folderPrefix?: string;

    @ApiPropertyOptional({
        description: 'Hex-encoded AES-128 encryption key (32 hex chars = 16 bytes)',
    })
    @IsString()
    @IsHexadecimal()
    @Length(32, 32)
    @IsOptional()
    @Expose()
    encryptionKey?: string;
}
