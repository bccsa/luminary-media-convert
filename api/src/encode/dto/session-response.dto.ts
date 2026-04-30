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
            'TUS upload endpoint. Create a tus upload to this URL, passing the sessionId as upload metadata.',
        example: 'http://localhost:3000/api/tus',
    })
    @Expose()
    tusEndpoint: string;

    @ApiProperty({
        description:
            'Bearer token to authenticate session requests (tus uploads, polling, preview). Send as "Authorization: Bearer <token>".',
        example: 'sess_f8e7d6c5b4a3291087654321',
    })
    @Expose()
    sessionToken: string;

    @ApiProperty({
        description:
            'Maximum allowed upload file size in bytes.',
        example: 10737418240,
    })
    @Expose()
    maxUploadSize: number;
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
    pipelineProgress?: { encoding: number; encrypting?: number; uploading?: number };

    @ApiPropertyOptional({
        description:
            'Position in the encoding queue (1-based). Present when status is "queued".',
        example: 2,
    })
    @Expose()
    queuePosition?: number;

    @ApiPropertyOptional({
        description: 'Probe results from the uploaded file. Present when status is "uploaded".',
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
            'Per-angle playlists for angle switching. Present when status is "completed" and video was encoded.',
        example: [
            { name: 'Main angle', key: 'videos/project-1/master.m3u8' },
            { name: 'Side angle', key: 'videos/project-1/side_angle.m3u8' },
        ],
    })
    @Expose()
    anglePlaylists?: { name: string; key: string }[];

    @ApiPropertyOptional({
        description:
            'S3 object key of the WebVTT thumbnails file. Present when status is "completed" and thumbnails were generated.',
        example: 'videos/project-1/thumbnails/thumbnails.vtt',
    })
    @Expose()
    thumbnailsVtt?: string;

    @ApiPropertyOptional({
        description:
            'Hex-encoded AES-128 encryption key. Present when status is "completed" and encryption was enabled.',
        example: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    })
    @Expose()
    encryptionKeyHex?: string;

    @ApiPropertyOptional({
        description:
            'Error message. Present when status is "failed".',
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
            'when source streams have misaligned start times, because the player\'s TS transmuxer ' +
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
}
