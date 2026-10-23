import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
    ArrayMaxSize,
    IsArray,
    IsNotEmpty,
    IsString,
    MaxLength,
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
}
