import { IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

/**
 * A chapter sidecar for a session, written next to its output in S3.
 *
 * The session already knows the bucket and the prefix, so unlike the stateless
 * `/api/hls/chapters/write` route this carries only the document itself.
 */
export class ChaptersWriteDto {
    @ApiProperty({
        description: 'WebVTT chapter document. Must start with `WEBVTT`. Max 1 MiB.',
        example: 'WEBVTT\n\n00:00:00.000 --> 00:01:30.000\nOpening\n',
    })
    @IsString()
    @Expose()
    vtt: string;
}
