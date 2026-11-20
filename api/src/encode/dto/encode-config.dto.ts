import {
    IsArray,
    IsBoolean,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    ValidateBy,
    ValidateNested,
    ValidateIf,
    buildMessage,
    type ValidationOptions,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    ANGLE_ACCESSIBILITY,
    type AngleAccessibility,
} from '@luminary-media-converter/hls-core';
import { assertAngleLanguage } from '../../hls-edit/video-angles.js';

/** The hearing-impaired kinds of view an angle can be, as the API names them. */
const ACCESSIBILITY_KINDS = Object.keys(
    ANGLE_ACCESSIBILITY
) as AngleAccessibility[];

/**
 * A camera angle's language by the rule the published-video editor writes
 * `LANGUAGE` with ({@link assertAngleLanguage}): empty for none, else an ISO
 * 639 code as an audio track takes it. Checked here, so a code the master
 * could not carry is refused when the encode is started, not when its master
 * is written at the end.
 */
function IsAngleLanguage(options?: ValidationOptions): PropertyDecorator {
    return ValidateBy(
        {
            name: 'isAngleLanguage',
            validator: {
                validate: (value: unknown) => {
                    if (typeof value !== 'string') return false;
                    try {
                        assertAngleLanguage(value);
                        return true;
                    } catch {
                        return false;
                    }
                },
                defaultMessage: buildMessage(
                    (each) =>
                        `${each}$property must be an ISO 639 language code ` +
                        '(e.g. "en" or "fra"), or empty for none',
                    options
                ),
            },
        },
        options
    );
}

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

    @ApiProperty({
        description: 'If true, copies the source stream without re-encoding.',
        example: false,
    })
    @IsBoolean()
    @Expose()
    copyStream: boolean;

    @ApiPropertyOptional({
        description:
            'Source video track index (required when copyStream is true).',
        example: 0,
    })
    @IsNumber()
    @IsOptional()
    @Expose()
    sourceTrackIndex?: number;

    @ApiPropertyOptional({
        description:
            'Which camera angle this rendition belongs to, by angle id — the ' +
            "id its videoTrackNames entry is filed under. Several source tracks " +
            'can be one angle (a copied ladder), so this is not always the ' +
            'source track. Defaults to sourceTrackIndex.',
        example: 0,
    })
    @IsInt()
    @Min(0)
    @IsOptional()
    @Expose()
    angle?: number;

    @ApiProperty({
        description: 'Audio group ID this rendition uses.',
        example: 'hd',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    audioGroupId: string;

    @ApiPropertyOptional({
        description: 'Human-readable label for the HLS NAME attribute.',
        example: '1080p',
    })
    @IsString()
    @IsOptional()
    @Expose()
    label?: string;

    @ApiPropertyOptional({
        description: 'Use VBR encoding (CRF/CQ) instead of fixed bitrate.',
        example: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    vbr?: boolean;
}

export class AudioGroupDto {
    @ApiProperty({
        description: 'Unique ID for this audio group.',
        example: 'hd',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    id: string;

    @ApiPropertyOptional({
        description: 'Human-readable label.',
        example: 'HD Audio',
    })
    @IsString()
    @IsOptional()
    @Expose()
    label?: string;

    @ApiProperty({ description: 'Audio bitrate in kbps.', example: 192 })
    @IsNumber()
    @Min(1)
    @Expose()
    audioBitrateKbps: number;

    @ApiProperty({
        description: 'Number of audio channels (1=mono, 2=stereo).',
        example: 2,
    })
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

    @ApiPropertyOptional({
        description: 'ISO 639 language code.',
        example: 'eng',
    })
    @IsString()
    @IsOptional()
    @Expose()
    language?: string;

    @ApiPropertyOptional({
        description: 'Copy source audio without re-encoding.',
        example: false,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    copyStream?: boolean;

    @ApiPropertyOptional({
        description: 'Use VBR encoding instead of CBR.',
        example: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    vbr?: boolean;
}

export class VideoTrackNameDto {
    @ApiProperty({ description: 'Source video track index.', example: 0 })
    @IsNumber()
    @Min(0)
    @Expose()
    index: number;

    @ApiProperty({
        description: 'Display name for the video track.',
        example: 'Main angle',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Expose()
    name: string;

    @ApiPropertyOptional({
        description:
            "The angle's LANGUAGE (ISO 639): the audio language its picture " +
            'belongs to (burnt-in titles, lip sync), which a player follows ' +
            'the audio to. Read from the entry an angle is filed under, and ' +
            'written only when the encode has more than one angle. Empty or ' +
            'left out for none.',
        example: 'fra',
    })
    @IsOptional()
    @IsString()
    @MaxLength(16)
    @IsAngleLanguage()
    @Expose()
    language?: string;

    @ApiPropertyOptional({
        enum: ACCESSIBILITY_KINDS,
        description:
            "The angle's hearing-impaired kind of view, written as its " +
            'CHARACTERISTICS. A player keeps a viewer on this kind of view ' +
            'when the audio language changes. Left out for none.',
    })
    @IsOptional()
    @IsIn(ACCESSIBILITY_KINDS)
    @Expose()
    accessibility?: AngleAccessibility;
}

export class VideoTrackAngleDto {
    @ApiProperty({ description: 'Source video track index.', example: 1 })
    @IsInt()
    @Min(0)
    @Expose()
    index: number;

    @ApiProperty({
        description: 'The angle id the track belongs to.',
        example: 0,
    })
    @IsInt()
    @Min(0)
    @Expose()
    angle: number;
}

export class TrimSegmentDto {
    @ApiProperty({ description: 'In-point in seconds.', example: 11.954 })
    @IsNumber()
    @Min(0)
    @Expose()
    inSec: number;

    @ApiProperty({ description: 'Out-point in seconds.', example: 130.048 })
    @IsNumber()
    @Min(0)
    @Expose()
    outSec: number;
}

export class EncodeConfigDto {
    @ApiProperty({
        description: 'Encoding type.',
        enum: ['video', 'audio'],
        example: 'video',
    })
    @IsString()
    @IsNotEmpty()
    @IsIn(['video', 'audio'])
    @Expose()
    type: 'video' | 'audio';

    @ApiPropertyOptional({
        description: 'HLS segment duration in seconds.',
        default: 6,
        example: 6,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    segmentDuration?: number;

    @ApiPropertyOptional({
        description: 'Video renditions (required when type is video).',
        type: [VideoRenditionDto],
    })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => VideoRenditionDto)
    @ValidateIf((o) => o.type === 'video')
    @Expose()
    videoRenditions?: VideoRenditionDto[];

    @ApiPropertyOptional({
        description: 'Audio groups for quality tiers and language grouping.',
        type: [AudioGroupDto],
    })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => AudioGroupDto)
    @Expose()
    audioGroups?: AudioGroupDto[];

    @ApiPropertyOptional({
        description:
            'Video track display names for angle playlist naming (used when ' +
            'type is video). The entry an angle is filed under (its id, as ' +
            'renditions name it in angle) can also give the angle a language ' +
            'and a hearing-impaired kind of view, which the master writes as ' +
            'LANGUAGE and CHARACTERISTICS on its TYPE=VIDEO line.',
        example: [
            { index: 0, name: 'Main angle', language: 'eng' },
            { index: 1, name: 'French titles', language: 'fra' },
            {
                index: 2,
                name: 'Sign language',
                accessibility: 'sign-language',
            },
        ],
    })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => VideoTrackNameDto)
    @ValidateIf((o) => o.type === 'video')
    @Expose()
    videoTrackNames?: VideoTrackNameDto[];

    @ApiPropertyOptional({
        description:
            'The angle each kept source track belongs to. Not used by the ' +
            'encode, whose renditions name their own angle; kept with the ' +
            'session so a restored config puts a track no rendition is made ' +
            'from back in its angle.',
        example: [
            { index: 0, angle: 0 },
            { index: 1, angle: 0 },
        ],
    })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => VideoTrackAngleDto)
    @ValidateIf((o) => o.type === 'video')
    @Expose()
    videoTrackAngles?: VideoTrackAngleDto[];

    @ApiPropertyOptional({
        description:
            'Use byte-range HLS segments (one file per rendition, split if exceeding max file size). Defaults to true.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    byteRange?: boolean;

    @ApiPropertyOptional({
        description:
            'Trim segments — when set, only these time ranges are encoded and concatenated in order. Each segment must be at least 0.5s and segments must not overlap.',
        type: [TrimSegmentDto],
    })
    @IsArray()
    @IsOptional()
    @ValidateNested({ each: true })
    @Type(() => TrimSegmentDto)
    @Expose()
    trimSegments?: TrimSegmentDto[];
}
