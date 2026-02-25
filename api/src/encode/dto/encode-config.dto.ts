import {
    IsArray,
    IsBoolean,
    IsIn,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Min,
    ValidateNested,
    ValidateIf,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class VideoRenditionDto {
    @ApiProperty({ description: 'Output width in pixels.', example: 1920 })
    @IsNumber()
    @Min(1)
    @Expose()
    width: number;

    @ApiProperty({ description: 'Output height in pixels.', example: 1080 })
    @IsNumber()
    @Min(1)
    @Expose()
    height: number;

    @ApiProperty({ description: 'Video bitrate in kbps.', example: 5000 })
    @IsNumber()
    @Min(1)
    @Expose()
    videoBitrateKbps: number;

    @ApiProperty({ description: 'If true, copies the source stream without re-encoding.', example: false })
    @IsBoolean()
    @Expose()
    copyStream: boolean;

    @ApiPropertyOptional({ description: 'Source video track index (required when copyStream is true).', example: 0 })
    @IsNumber()
    @IsOptional()
    @Expose()
    sourceTrackIndex?: number;

    @ApiProperty({ description: 'Audio group ID this rendition uses.', example: 'hd' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    audioGroupId: string;

    @ApiPropertyOptional({ description: 'Human-readable label for the HLS NAME attribute.', example: '1080p' })
    @IsString()
    @IsOptional()
    @Expose()
    label?: string;

    @ApiPropertyOptional({ description: 'Use VBR encoding (CRF/CQ) instead of fixed bitrate.', example: true })
    @IsBoolean()
    @IsOptional()
    @Expose()
    vbr?: boolean;
}

export class AudioGroupDto {
    @ApiProperty({ description: 'Unique ID for this audio group.', example: 'hd' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    id: string;

    @ApiPropertyOptional({ description: 'Human-readable label.', example: 'HD Audio' })
    @IsString()
    @IsOptional()
    @Expose()
    label?: string;

    @ApiProperty({ description: 'Audio bitrate in kbps.', example: 192 })
    @IsNumber()
    @Min(1)
    @Expose()
    audioBitrateKbps: number;

    @ApiProperty({ description: 'Number of audio channels (1=mono, 2=stereo).', example: 2 })
    @IsNumber()
    @IsIn([1, 2, 6, 8])
    @Expose()
    channels: number;

    @ApiProperty({ description: 'Audio codec.', enum: ['aac'], default: 'aac' })
    @IsString()
    @IsIn(['aac'])
    @Expose()
    audioCodec: 'aac';

    @ApiProperty({ description: 'Source audio track index.', example: 0 })
    @IsNumber()
    @Expose()
    sourceTrackIndex: number;

    @ApiPropertyOptional({ description: 'ISO 639 language code.', example: 'eng' })
    @IsString()
    @IsOptional()
    @Expose()
    language?: string;

    @ApiPropertyOptional({ description: 'Copy source audio without re-encoding.', example: false })
    @IsBoolean()
    @IsOptional()
    @Expose()
    copyStream?: boolean;

    @ApiPropertyOptional({ description: 'Use VBR encoding instead of CBR.', example: true })
    @IsBoolean()
    @IsOptional()
    @Expose()
    vbr?: boolean;
}

export class EncodeConfigDto {
    @ApiProperty({ description: 'Encoding type.', enum: ['video', 'audio'], example: 'video' })
    @IsString()
    @IsNotEmpty()
    @IsIn(['video', 'audio'])
    @Expose()
    type: 'video' | 'audio';

    @ApiPropertyOptional({ description: 'HLS segment duration in seconds.', default: 6, example: 6 })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    segmentDuration?: number;

    @ApiPropertyOptional({ description: 'Video renditions (required when type is video).', type: [VideoRenditionDto] })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => VideoRenditionDto)
    @ValidateIf(o => o.type === 'video')
    @Expose()
    videoRenditions?: VideoRenditionDto[];

    @ApiPropertyOptional({ description: 'Audio groups for quality tiers and language grouping.', type: [AudioGroupDto] })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => AudioGroupDto)
    @Expose()
    audioGroups?: AudioGroupDto[];

    @ApiPropertyOptional({
        description:
            'Video track display names for angle playlist naming (used when type is video).',
        example: [{ index: 0, name: 'Main angle' }, { index: 1, name: 'Side angle' }],
    })
    @IsArray()
    @IsOptional()
    @ValidateIf(o => o.type === 'video')
    @Expose()
    videoTrackNames?: { index: number; name: string }[];
}
