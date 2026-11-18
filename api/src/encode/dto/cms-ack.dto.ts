import { IsNotEmpty, IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/** The CMS confirming it has stored a version of the video. */
export class CmsAckDto {
    @ApiProperty({
        description:
            "The hlsUrl the CMS stored, exactly as the encoder announced it. Only the session's " +
            'current hlsUrl counts.',
        example: 'https://cdn.example.com/media/a1b2c3d4/master_r1.m3u8',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    hlsUrl: string;
}
