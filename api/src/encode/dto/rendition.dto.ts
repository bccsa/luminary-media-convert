import { IsNumber, IsOptional, IsString, IsIn, Min } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RenditionDto {
    @ApiPropertyOptional({
        description:
            'Output width in pixels. Required for video renditions.',
        example: 1280,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    width?: number;

    @ApiPropertyOptional({
        description:
            'Output height in pixels. Required for video renditions.',
        example: 720,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    height?: number;

    @ApiPropertyOptional({
        description:
            'Video bitrate in kbps. Required for video renditions.',
        example: 2500,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    videoBitrateKbps?: number;

    @ApiProperty({
        description: 'Audio bitrate in kbps.',
        example: 128,
    })
    @IsNumber()
    @Min(1)
    @Expose()
    audioBitrateKbps: number;

    @ApiPropertyOptional({
        description: 'Audio codec to use. Defaults to aac.',
        enum: ['aac'],
        default: 'aac',
    })
    @IsString()
    @IsOptional()
    @IsIn(['aac'])
    @Expose()
    audioCodec?: 'aac';
}
