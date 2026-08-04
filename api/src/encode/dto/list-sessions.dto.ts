import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import type { SessionStatus } from './webhook-payload.dto.js';

const SESSION_STATUSES: SessionStatus[] = [
    'created',
    'uploading',
    'uploaded',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
    'completed',
    'failed',
];

export class ListSessionsQueryDto {
    @ApiPropertyOptional({
        description: 'Maximum sessions to return.',
        default: 25,
        example: 25,
    })
    @IsInt()
    @IsOptional()
    @Min(1)
    @Type(() => Number)
    @Expose()
    limit?: number;

    @ApiPropertyOptional({
        description: 'Sessions to skip, for paging.',
        default: 0,
        example: 0,
    })
    @IsInt()
    @IsOptional()
    @Min(0)
    @Type(() => Number)
    @Expose()
    skip?: number;

    @ApiPropertyOptional({
        description: 'Only return sessions in this status.',
        enum: SESSION_STATUSES,
        example: 'completed',
    })
    @IsString()
    @IsOptional()
    @IsIn(SESSION_STATUSES)
    @Expose()
    status?: SessionStatus;

    @ApiPropertyOptional({
        description:
            'Case-insensitive match against the session name or id. An id is what a log line or webhook payload gives you, so both are searched.',
        example: 'interview',
    })
    @IsString()
    @IsOptional()
    @MaxLength(200)
    @Expose()
    search?: string;
}
