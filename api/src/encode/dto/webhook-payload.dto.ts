import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type SessionStatus =
    | 'created'
    | 'uploaded'
    | 'uploading'
    | 'queued'
    | 'encoding'
    | 'uploading_to_s3'
    | 'completed'
    | 'failed';

export class WebhookPayloadDto {
    @ApiProperty({
        description: 'Session identifier.',
        example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    })
    sessionId: string;

    @ApiProperty({
        description: 'Current session status.',
        enum: [
            'queued',
            'encoding',
            'uploading_to_s3',
            'completed',
            'failed',
        ],
        example: 'encoding',
    })
    status: SessionStatus;

    @ApiPropertyOptional({
        description: 'Encoding progress percentage (0-100).',
        example: 45.5,
    })
    progress?: number;

    @ApiPropertyOptional({
        description: 'Queue position (1-based) when status is "queued".',
        example: 2,
    })
    queuePosition?: number;

    @ApiPropertyOptional({
        description: 'Human-readable status message.',
        example: 'Encoding in progress',
    })
    message?: string;

    @ApiPropertyOptional({
        description: 'Error description when status is "failed".',
        example: 'FFmpeg exited with code 1',
    })
    error?: string;

    @ApiPropertyOptional({
        description:
            'List of all S3 object keys uploaded. Present on "completed".',
        example: [
            'videos/project-1/master.m3u8',
            'videos/project-1/v0/playlist.m3u8',
        ],
    })
    files?: string[];

    @ApiPropertyOptional({
        description:
            'S3 object key of the master HLS playlist. Present on "completed".',
        example: 'videos/project-1/master.m3u8',
    })
    masterPlaylist?: string;
}
