import { IsNotEmpty, IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A file the user picked in the local app.
 *
 * The encoder reads it where it lies — this is a reference, not an upload — so
 * the path must be one this process can see and must belong to the user, who
 * keeps it either way.
 */
export class LocalFileDto {
    @ApiProperty({
        description:
            'Absolute path to a media file on this machine. The file is read in ' +
            'place: never copied, moved, or deleted.',
        example: '/Users/alex/Movies/episode-12.mov',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    path: string;
}
