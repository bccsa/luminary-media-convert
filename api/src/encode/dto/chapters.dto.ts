import { IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A chapter document for a session, written next to its output in S3 under a
 * name of its own. The session already knows the bucket and the prefix, so
 * this carries only the document itself.
 */
export class ChaptersWriteDto {
    @ApiProperty({
        description:
            'WebVTT chapter document. Must start with `WEBVTT`. Max 1 MiB.',
        example: 'WEBVTT\n\n00:00:00.000 --> 00:01:30.000\nOpening\n',
    })
    @IsString()
    @Expose()
    vtt: string;
}

/**
 * Where a chapter save left the video. Empty while the encode has not
 * published a master yet: the chapters wait for it, and the encode names them
 * in the master it writes.
 */
export class ChaptersSaveResultDto {
    @ApiPropertyOptional({
        description: 'Public URL of the master revision that now names the chapters.',
    })
    @Expose()
    hlsUrl?: string;

    @ApiPropertyOptional({ description: "That revision's object key." })
    @Expose()
    masterPlaylist?: string;

    @ApiPropertyOptional({ description: "That revision's ETag." })
    @Expose()
    etag?: string;

    @ApiPropertyOptional({
        description:
            'The CMS confirmed it stored the new version. False when it has not yet; absent ' +
            'for a session with no CMS behind it.',
    })
    @Expose()
    published?: boolean;
}
