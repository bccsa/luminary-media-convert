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
            'Bearer token to authenticate tus upload requests. Send as "Authorization: Bearer <token>".',
        example: 'tok_f8e7d6c5b4a3291087654321',
    })
    @Expose()
    uploadToken: string;

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
        description: 'Suggested encoding configuration. Present when status is "uploaded".',
    })
    @Expose()
    suggestedConfig?: any;

    @ApiPropertyOptional({
        description:
            'List of S3 object keys for all uploaded files. Present when status is "completed".',
        example: [
            'videos/project-1/master.m3u8',
            'videos/project-1/v0/playlist.m3u8',
            'videos/project-1/v0/segment_000.ts',
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
            'Error message. Present when status is "failed".',
        example: 'FFmpeg exited with code 1: Invalid input file',
    })
    @Expose()
    error?: string;
}
