import { IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
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
}
