import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsInt,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    MaxLength,
    Min,
    ValidateNested,
} from 'class-validator';

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

export class EncodedMediaDto {
    @ApiProperty({ type: AudioTrackDto, isArray: true })
    @Expose()
    tracks: AudioTrackDto[];

    @ApiProperty({
        example: ['en'],
        description: 'Languages with a chapters/<lang>.vtt.',
    })
    @Expose()
    chapterLanguages: string[];

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
}
