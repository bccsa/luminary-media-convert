import { IsString, MaxLength, MinLength } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class LocalSourceDto {
    @ApiProperty({
        description:
            'Absolute path to a source media file already present on the encoder host. ' +
            'The file is read in place — it is never copied into the work directory, ' +
            'and it is left untouched if the session fails. Only available when the ' +
            'encoder runs ALLOW_LOCAL_SOURCE=true, which is intended for the desktop ' +
            'build where the encoder and the user share a filesystem.',
        example: '/Users/alex/Movies/interview.mov',
    })
    @IsString()
    @MinLength(1)
    @MaxLength(4096)
    @Expose()
    path: string;
}
