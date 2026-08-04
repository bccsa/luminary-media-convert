import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { basename } from 'path';
import type { Session } from '../services/session.service.js';
import type { SessionStatus } from './webhook-payload.dto.js';

/**
 * A session as it appears in a listing.
 *
 * Built by hand rather than serialising the session, because the session record
 * holds things a listing must never carry: `sessionToken`, the S3 access and
 * secret keys inside `config.s3`, and `encryptionKeyHex`. An allow-list fails
 * safe when new fields are added to the session; a deny-list does not.
 */
export class SessionSummaryDto {
    @ApiProperty({ example: 'c0ffee00-0000-4000-8000-000000000000' })
    id: string;

    @ApiPropertyOptional({ example: 'Interview — final cut' })
    name?: string;

    @ApiProperty({ example: 'completed' })
    status: SessionStatus;

    @ApiProperty({ example: 100 })
    progress: number;

    @ApiPropertyOptional({
        description: 'Source file name. The path itself is not exposed.',
        example: 'interview.mov',
    })
    filename?: string;

    @ApiPropertyOptional({ example: 'output/master.m3u8' })
    masterPlaylist?: string;

    @ApiPropertyOptional({ description: 'Number of objects written to S3.' })
    fileCount?: number;

    @ApiProperty({ description: 'Whether HLS output is AES-128 encrypted.' })
    encrypted: boolean;

    @ApiPropertyOptional({ description: 'Source duration in seconds.' })
    durationSec?: number;

    @ApiPropertyOptional({ example: 'media' })
    bucket?: string;

    @ApiPropertyOptional({ example: 'projects/interview' })
    pathPrefix?: string;

    @ApiPropertyOptional({ description: 'Failure reason, when status is failed.' })
    error?: string;

    @ApiProperty({ example: 1754308800000 })
    createdAt: number;

    @ApiPropertyOptional({ example: 1754309400000 })
    completedAt?: number;
}

export function toSessionSummary(session: Session): SessionSummaryDto {
    return {
        id: session.id,
        name: session.name,
        status: session.status,
        progress: session.progress,
        filename: session.filePath ? basename(session.filePath) : undefined,
        masterPlaylist: session.masterPlaylist,
        fileCount: session.files?.length,
        // Either the key was generated, or encryption was asked for and the
        // encode has not reached the point of producing one yet.
        encrypted: Boolean(
            session.encryptionKeyHex ??
                (session.config.encryption &&
                    session.config.encryption.enabled !== false)
        ),
        durationSec: session.probeResult?.format?.duration,
        bucket: session.config.s3?.bucket,
        pathPrefix: session.config.s3?.pathPrefix,
        error: session.error,
        createdAt: session.createdAt,
        completedAt: session.completedAt,
    };
}
