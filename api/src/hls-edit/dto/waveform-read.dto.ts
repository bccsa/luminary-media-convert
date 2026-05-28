import { IsString, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';

export class HlsWaveformReadRequestDto {
    @ApiProperty({ type: S3ConfigDto })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiProperty({
        description:
            'Folder prefix containing the HLS output. Trailing slash optional.',
    })
    @IsString()
    @Expose()
    folderPrefix: string;
}

export interface HlsWaveformReadResult {
    /** Schema version of the sidecar (1 for now). */
    version: number;
    /** PCM sample rate used to compute peaks (8000 Hz mono in the current pipeline). */
    sampleRate: number;
    /** Number of peaks in the array. */
    numPeaks: number;
    /** Normalized 0–1 amplitude peaks. */
    peaks: number[];
}
