import { IsOptional, IsString, ValidateNested } from 'class-validator';
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
        description: 'Folder prefix (or full URL) to scan. Mutually usable with masterPlaylistKey — if it ends with .m3u8, the enclosing folder is scanned.',
    })
    @IsString()
    @IsOptional()
    @Expose()
    folderPrefix?: string;

    @ApiPropertyOptional({
        description: 'A specific master playlist key; its enclosing folder is scanned.',
    })
    @IsString()
    @IsOptional()
    @Expose()
    masterPlaylistKey?: string;
}
