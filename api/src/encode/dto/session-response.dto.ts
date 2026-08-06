import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { ProbeResultDto } from './probe-result.dto.js';

export class SessionResponseDto {
    @ApiProperty({
        description: 'Unique session identifier.',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })
    @Expose()
    sessionId: string;

    @ApiProperty({
        description:
            'Bearer token to authenticate session requests (ingestion, polling, preview). Send as "Authorization: Bearer <token>".',
        example: 'sess_f8e7d6c5b4a3291087654321',
    })
    @Expose()
    sessionToken: string;
}

export class EncodeStartResponseDto {
    @ApiProperty({
        description: 'Session identifier.',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })
    @Expose()
    sessionId: string;

    @ApiProperty({
        description: 'Current session status.',
        example: 'queued',
    })
    @Expose()
    status: string;

    @ApiPropertyOptional({
        description: 'Position in the encoding queue (1-based).',
        example: 1,
    })
    @Expose()
    queuePosition?: number;
}

/**
 * One row of the local session list.
 *
 * Carries the session token, which the status response never does: this
 * endpoint is master-key-only and exists for the local UI, which needs a
 * per-session credential for the preview and waveform routes without having to
 * remember one from whenever the session was created.
 */
export class SessionSummaryDto {
    @ApiProperty({ description: 'Session identifier.' })
    @Expose()
    sessionId: string;

    @ApiPropertyOptional({
        description: 'Title supplied when the session was created.',
    })
    @Expose()
    title?: string;

    @ApiProperty({
        description: 'Current session status.',
        example: 'encoding',
    })
    @Expose()
    status: string;

    @ApiProperty({ description: 'Progress percentage (0-100).', example: 42 })
    @Expose()
    progress: number;

    @ApiProperty({
        description: 'Creation time, epoch milliseconds.',
        example: 1770000000000,
    })
    @Expose()
    createdAt: number;

    @ApiProperty({
        description: 'Bearer token for the session-scoped endpoints.',
        example: 'sess_f8e7d6c5b4a3291087654321',
    })
    @Expose()
    sessionToken: string;

    @ApiPropertyOptional({
        description: 'Public playback URL, once encoding has started.',
    })
    @Expose()
    hlsUrl?: string;

    @ApiPropertyOptional({
        description: 'Failure message, when status is "failed".',
    })
    @Expose()
    error?: string;
}

export class SessionStatusDto {
    @ApiProperty({
        description: 'Session identifier.',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })
    @Expose()
    sessionId: string;

    @ApiProperty({
        description: 'Current session status.',
        enum: [
            'created',
            'uploaded',
            'uploading',
            'queued',
            'encoding',
            'encrypting',
            'uploading_to_s3',
            'completed',
            'failed',
        ],
        example: 'encoding',
    })
    @Expose()
    status: string;

    @ApiPropertyOptional({
        description:
            'Encoding progress as a percentage (0-100). Present when status is "encoding".',
        example: 45.5,
    })
    @Expose()
    progress?: number;

    @ApiPropertyOptional({
        description:
            'Detailed pipeline progress with separate encoding, encrypting, and uploading indicators. ' +
            'Present when status is "encoding" or "uploading_to_s3".',
        example: { encoding: 45.5, encrypting: 30, uploading: 10 },
    })
    @Expose()
    pipelineProgress?: {
        encoding: number;
        encrypting?: number;
        uploading?: number;
    };

    @ApiPropertyOptional({
        description:
            'Position in the encoding queue (1-based). Present when status is "queued".',
        example: 2,
    })
    @Expose()
    queuePosition?: number;

    @ApiPropertyOptional({
        description:
            'The encode can be run again without re-uploading. Present when status is ' +
            '"failed" and the uploaded source is still on the encoder. A failure is ' +
            'usually transient — a full disk, a stalled upload, a restart — and leaves ' +
            'the source untouched.',
        example: true,
    })
    @Expose()
    canRetry?: boolean;

    @ApiPropertyOptional({
        description:
            'Whether the output will use byte-range HLS. Set at session creation ' +
            'and not editable afterwards, so the client has no other way to learn ' +
            'it — the encode config form used to assume the API default.',
        example: true,
    })
    @Expose()
    byteRange?: boolean;

    @ApiPropertyOptional({
        description:
            'Probe results from the uploaded file. Present when status is "uploaded".',
        type: ProbeResultDto,
    })
    @Type(() => ProbeResultDto)
    @Expose()
    probeResult?: ProbeResultDto;

    @ApiPropertyOptional({
        description:
            'List of S3 object keys for all uploaded files. Present when status is "completed".',
        example: [
            'videos/project-1/master.m3u8',
            'videos/project-1/stream_1080p_1920x1080/playlist.m3u8',
            'videos/project-1/stream_1080p_1920x1080/init.mp4',
            'videos/project-1/stream_1080p_1920x1080/segment_000.m4s',
        ],
    })
    @Expose()
    files?: string[];

    @ApiPropertyOptional({
        description:
            'S3 object key of the master HLS playlist. Present when status is "completed".',
        example: 'videos/project-1/master.m3u8',
    })
    @Expose()
    masterPlaylist?: string;

    @ApiPropertyOptional({
        description:
            'S3 object key of the WebVTT thumbnails file. Present when status is "completed" and thumbnails were generated.',
        example: 'videos/project-1/thumbnails/thumbnails.vtt',
    })
    @Expose()
    thumbnailsVtt?: string;

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 encryption key. Present from the moment encoding ' +
            'starts, when encryption is enabled — the key is generated before the ' +
            'first segment is written so the caller can store it alongside hlsUrl.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @Expose()
    encryptionKeyHex?: string;

    @ApiPropertyOptional({
        description:
            'Public URL of the master playlist, built from the caller-supplied ' +
            "publicBaseUrl and the session's object key. Present from the moment " +
            'encoding starts, for sessions created with a publicBaseUrl.',
        example: 'https://cdn.example.com/media/a1b2c3d4/master.m3u8',
    })
    @Expose()
    hlsUrl?: string;

    @ApiPropertyOptional({
        description: 'Title supplied by the caller that opened the session.',
        example: 'Episode 12 — The Long Way Round',
    })
    @Expose()
    title?: string;

    @ApiPropertyOptional({
        description: "The CMS document this session's output belongs to.",
        example: 'post_01HTZ8Y0J4',
    })
    @Expose()
    documentId?: string;

    @ApiPropertyOptional({
        description: 'Error message. Present when status is "failed".',
        example: 'FFmpeg exited with code 1: Invalid input file',
    })
    @Expose()
    error?: string;

    @ApiPropertyOptional({
        description:
            'Hardware acceleration mode used by the server for video encoding.',
        enum: ['cpu', 'nvidia', 'apple'],
        example: 'cpu',
    })
    @Expose()
    encoder?: string;

    @ApiPropertyOptional({
        description:
            'HLS segment format used for encoding. "fmp4" (CMAF-compatible, lower overhead) ' +
            'is used when source stream start times are aligned. "mpegts" is used as a fallback ' +
            "when source streams have misaligned start times, because the player's TS transmuxer " +
            'can synchronize audio and video during playback.',
        enum: ['fmp4', 'mpegts'],
        example: 'fmp4',
    })
    @Expose()
    segmentFormat?: string;

    @ApiPropertyOptional({
        description:
            'Total bytes for the source being ingested. Present during URL ingestion ' +
            'when the source server reported a Content-Length.',
        example: 524288000,
    })
    @Expose()
    ingestTotalBytes?: number;

    @ApiPropertyOptional({
        description:
            'Trim ranges submitted with the encode config, in source-timeline seconds. ' +
            'Present once encoding has been requested and the config specified trimming. ' +
            'Clients use these to render the output timeline (duration, waveform) rather ' +
            'than the source timeline, including after a page reload.',
        example: [
            { inSec: 10, outSec: 20 },
            { inSec: 40, outSec: 50 },
        ],
    })
    @Expose()
    trimSegments?: { inSec: number; outSec: number }[];
}
