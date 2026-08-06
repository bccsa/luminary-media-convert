import { IsString, Matches, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
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
}
