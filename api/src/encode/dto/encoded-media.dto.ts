import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsIn,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';
import {
    ANGLE_ACCESSIBILITY,
    type AngleAccessibility,
} from '@luminary-media-converter/hls-core';

/** The hearing-impaired kinds of view an angle can be, as the API names them. */
const ACCESSIBILITY_KINDS = Object.keys(
    ANGLE_ACCESSIBILITY
) as AngleAccessibility[];

/** An audio track named by its language and name, the pair the players fold groups on. */
export class AudioTrackIdentityDto {
    @ApiProperty({
        example: 'fr',
        description: 'LANGUAGE; empty for a track without one.',
    })
    @IsString()
    @MaxLength(16)
    @Expose()
    language: string;

    @ApiProperty({ example: 'Francais' })
    @IsString()
    @MaxLength(256)
    @Expose()
    name: string;
}

export class AudioTrackEditDto {
    @ApiProperty({
        type: AudioTrackIdentityDto,
        description: 'The track as it is.',
    })
    @ValidateNested()
    @Type(() => AudioTrackIdentityDto)
    @Expose()
    from: AudioTrackIdentityDto;

    @ApiProperty({
        type: AudioTrackIdentityDto,
        description: 'What it becomes.',
    })
    @ValidateNested()
    @Type(() => AudioTrackIdentityDto)
    @Expose()
    to: AudioTrackIdentityDto;
}

export class AudioTracksWriteDto {
    @ApiProperty({
        description:
            'The etag GET /api/sessions/:id/media returned: the save is refused (409) once the video has changed since.',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    ifMatch: string;

    @ApiProperty({ type: AudioTrackEditDto, isArray: true })
    @IsArray()
    @ArrayMaxSize(200)
    @ValidateNested({ each: true })
    @Type(() => AudioTrackEditDto)
    @Expose()
    edits: AudioTrackEditDto[];

    @ApiPropertyOptional({
        type: AudioTrackIdentityDto,
        isArray: true,
        description:
            'Tracks to take out of the master; their files stay in storage.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(200)
    @ValidateNested({ each: true })
    @Type(() => AudioTrackIdentityDto)
    @Expose()
    remove?: AudioTrackIdentityDto[];
}

export class AudioTrackDto {
    @ApiProperty({ example: 'fr' })
    @Expose()
    language: string;

    @ApiProperty({ example: 'Francais' })
    @Expose()
    name: string;

    @ApiProperty({
        example: ['aud_stereo', 'aud_mono'],
        description: 'The audio groups with a rendition of the track.',
    })
    @Expose()
    groups: string[];

    @ApiProperty({ description: 'DEFAULT=YES in any group.' })
    @Expose()
    default: boolean;
}

export class AudioSourceRequestDto {
    @ApiProperty({
        description:
            'Absolute path of an audio or video file on this machine, or an http(s) link to one or to an HLS playlist.',
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(4096)
    @Expose()
    path: string;
}

export class AddAudioTrackDto extends AudioSourceRequestDto {
    @ApiProperty({
        description:
            "The file's audio stream to take, among its audio streams.",
        example: 0,
    })
    @IsInt()
    @Min(0)
    @Expose()
    sourceTrackIndex: number;

    @ApiProperty({ example: 'fra' })
    @IsString()
    @MaxLength(16)
    @Expose()
    language: string;

    @ApiProperty({ example: 'Français' })
    @IsString()
    @MaxLength(256)
    @Expose()
    name: string;

    @ApiPropertyOptional({
        description:
            "Where the file starts on the video's timeline, in seconds: positive adds silence before it, negative drops its first seconds.",
        default: 0,
    })
    @IsOptional()
    @IsNumber()
    @Expose()
    offsetSec?: number;

    @ApiProperty({
        description: 'The etag GET /api/sessions/:id/media returned.',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    ifMatch: string;
}

export class AddAudioTrackJobDto {
    @ApiProperty({ enum: ['running', 'done', 'failed'] })
    @Expose()
    state: 'running' | 'done' | 'failed';

    @ApiProperty({
        enum: ['reading', 'encoding', 'uploading', 'saving', 'done'],
    })
    @Expose()
    phase: 'reading' | 'encoding' | 'uploading' | 'saving' | 'done';

    @ApiProperty({ description: '0–100 within the phase.' })
    @Expose()
    progress: number;

    @ApiProperty()
    @Expose()
    language: string;

    @ApiProperty()
    @Expose()
    name: string;

    @ApiPropertyOptional()
    @Expose()
    error?: string;
}

export class VideoAngleDto {
    @ApiProperty({
        example: 'pulpit',
        description:
            'GROUP-ID; empty for the single picture of a video without angles.',
    })
    @Expose()
    id: string;

    @ApiProperty({
        example: 'Pulpit',
        description: 'NAME; empty for that single picture.',
    })
    @Expose()
    name: string;

    @ApiProperty({
        example: 'fra',
        description:
            'LANGUAGE: the audio language the picture belongs to, which a player follows the audio to. Empty when it has none.',
    })
    @Expose()
    language: string;

    @ApiPropertyOptional({
        enum: ACCESSIBILITY_KINDS,
        description:
            'The hearing-impaired kind of view CHARACTERISTICS marks. Absent when it marks none.',
    })
    @Expose()
    accessibility?: AngleAccessibility;

    @ApiProperty({ description: 'The angle a player starts on.' })
    @Expose()
    default: boolean;

    @ApiProperty({ description: 'How many variants (sizes) it has.' })
    @Expose()
    renditions: number;
}

export class VideoAngleEditDto {
    @ApiProperty({ example: 'pulpit', description: 'The angle, by GROUP-ID.' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(256)
    @Expose()
    id: string;

    @ApiPropertyOptional({
        example: 'Pulpit camera',
        description: 'Its new name. Left out, the name stays.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    @Expose()
    name?: string;

    @ApiPropertyOptional({
        example: 'fra',
        description:
            'Its LANGUAGE (ISO 639): the audio language the picture belongs to. Empty takes it off; left out, it stays.',
    })
    @IsOptional()
    @IsString()
    @MaxLength(16)
    @Expose()
    language?: string;

    @ApiPropertyOptional({
        enum: [...ACCESSIBILITY_KINDS, 'none'],
        description:
            'Its hearing-impaired kind of view, written as CHARACTERISTICS. none takes it off when it marks one of these kinds, and leaves a value that marks none of them as it is; left out, it stays.',
    })
    @IsOptional()
    @IsIn([...ACCESSIBILITY_KINDS, 'none'])
    @Expose()
    accessibility?: AngleAccessibility | 'none';
}

export class VideoAnglesWriteDto {
    @ApiProperty({
        description:
            'The etag GET /api/sessions/:id/media returned: the save is refused (409) once the video has changed since.',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    ifMatch: string;

    @ApiProperty({ type: VideoAngleEditDto, isArray: true })
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => VideoAngleEditDto)
    @Expose()
    edits: VideoAngleEditDto[];

    @ApiPropertyOptional({
        type: String,
        isArray: true,
        description:
            'Angles (by GROUP-ID) to take out of the master; their files stay in storage.',
    })
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(50)
    @IsString({ each: true })
    @Expose()
    remove?: string[];
}

export class AddVideoAngleDto extends AudioSourceRequestDto {
    @ApiProperty({
        description:
            "The file's video stream to take, among its video streams.",
        example: 0,
    })
    @IsInt()
    @Min(0)
    @Expose()
    sourceTrackIndex: number;

    @ApiProperty({ example: 'Pulpit' })
    @IsString()
    @MaxLength(256)
    @Expose()
    name: string;

    @ApiPropertyOptional({
        example: 'Main',
        description:
            "What to call the video's own picture when it has no angles yet. Defaults to Main.",
    })
    @IsOptional()
    @IsString()
    @MaxLength(256)
    @Expose()
    mainName?: string;

    @ApiPropertyOptional({
        example: 'fra',
        description:
            "The new angle's LANGUAGE (ISO 639): the audio language its picture belongs to. Empty or left out for none.",
    })
    @IsOptional()
    @IsString()
    @MaxLength(16)
    @Expose()
    language?: string;

    @ApiPropertyOptional({
        enum: ACCESSIBILITY_KINDS,
        description:
            "The new angle's hearing-impaired kind of view, written as CHARACTERISTICS. Left out for none.",
    })
    @IsOptional()
    @IsIn(ACCESSIBILITY_KINDS)
    @Expose()
    accessibility?: AngleAccessibility;

    @ApiPropertyOptional({
        example: 'eng',
        description:
            "The LANGUAGE of the video's own picture when it has no angles yet, as it becomes the main one. Empty or left out for none.",
    })
    @IsOptional()
    @IsString()
    @MaxLength(16)
    @Expose()
    mainLanguage?: string;

    @ApiPropertyOptional({
        description:
            "Where the file starts on the video's timeline, in seconds: positive shows black before it, negative drops its first seconds.",
        default: 0,
    })
    @IsOptional()
    @IsNumber()
    @Expose()
    offsetSec?: number;

    @ApiProperty({
        description: 'The etag GET /api/sessions/:id/media returned.',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    ifMatch: string;
}

export class AddVideoAngleJobDto {
    @ApiProperty({ enum: ['running', 'done', 'failed'] })
    @Expose()
    state: 'running' | 'done' | 'failed';

    @ApiProperty({
        enum: ['reading', 'encoding', 'uploading', 'saving', 'done'],
    })
    @Expose()
    phase: 'reading' | 'encoding' | 'uploading' | 'saving' | 'done';

    @ApiProperty({ description: '0–100 within the phase.' })
    @Expose()
    progress: number;

    @ApiProperty()
    @Expose()
    name: string;

    @ApiPropertyOptional()
    @Expose()
    error?: string;
}

/** One language's subtitles in the master. */
export class SubtitleTrackDto {
    @ApiProperty({ example: 'fr', description: 'LANGUAGE (ISO 639).' })
    @Expose()
    language: string;

    @ApiProperty({ example: 'Français', description: 'NAME, as the players list it.' })
    @Expose()
    name: string;

    @ApiProperty({
        example: 'subtitles/fr_1a2b3c4d.m3u8',
        description: 'Its media playlist, relative to the master.',
    })
    @Expose()
    uri: string;

    @ApiProperty({ description: 'A player turns these subtitles on by itself.' })
    @Expose()
    default: boolean;
}

/** One language's subtitles, as WebVTT. */
export class SubtitlesDto {
    @ApiProperty({ example: 'fr' })
    @Expose()
    language: string;

    @ApiProperty({ example: 'Français' })
    @Expose()
    name: string;

    @ApiProperty({ description: 'The subtitles, as a WebVTT document.' })
    @Expose()
    vtt: string;
}

export class SubtitlesWriteDto {
    @ApiProperty({
        description:
            'The etag GET /api/sessions/:id/media returned: the save is refused (409) once the video has changed since.',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    ifMatch: string;

    @ApiProperty({ example: 'Français', description: 'The name players list them under.' })
    @IsString()
    @IsNotEmpty()
    @MaxLength(100)
    @Expose()
    name: string;

    @ApiProperty({ description: 'The subtitles, as a WebVTT document.' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    vtt: string;
}

export class EncodedMediaDto {
    @ApiProperty({ type: AudioTrackDto, isArray: true })
    @Expose()
    tracks: AudioTrackDto[];

    @ApiProperty({ type: VideoAngleDto, isArray: true })
    @Expose()
    angles: VideoAngleDto[];

    @ApiProperty({ type: SubtitleTrackDto, isArray: true })
    @Expose()
    subtitles: SubtitleTrackDto[];

    @ApiProperty({
        example: ['en'],
        description:
            'Languages with chapters: named in the master, or at the legacy chapters/<lang>.vtt.',
    })
    @Expose()
    chapterLanguages: string[];

    @ApiProperty({
        description:
            'Public URL of the master revision read — after a save, the one the save wrote. ' +
            'Every save writes a new revision, so this changes with each.',
        example: 'https://cdn.example.com/media/a1b2c3d4/master_r2.m3u8',
    })
    @Expose()
    hlsUrl: string;

    @ApiProperty({ description: "That revision's object key." })
    @Expose()
    masterPlaylist: string;

    @ApiPropertyOptional({
        description:
            'On a save: the CMS confirmed it stored the new version within the wait. False when ' +
            'the save landed but the CMS has not confirmed it yet. Absent on reads, and for a ' +
            'session with no CMS behind it.',
    })
    @Expose()
    published?: boolean;

    @ApiProperty({
        description:
            'Version of the master read; send it back as ifMatch to save.',
    })
    @Expose()
    etag: string;

    @ApiProperty({
        description:
            'The video is encrypted: its chapters are written encrypted too.',
    })
    @Expose()
    encrypted: boolean;

    @ApiPropertyOptional({
        type: AddAudioTrackJobDto,
        description: 'The audio track being added, or the last one.',
    })
    @Expose()
    adding?: AddAudioTrackJobDto;

    @ApiPropertyOptional({
        type: AddVideoAngleJobDto,
        description: 'The angle being added, or the last one.',
    })
    @Expose()
    addingAngle?: AddVideoAngleJobDto;
}
