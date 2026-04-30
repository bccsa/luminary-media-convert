import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsNumber, Min } from 'class-validator';

export class SetReviewRangeDto {
    @ApiProperty({
        description: 'Requested in-point in seconds.',
        example: 12.4,
    })
    @IsNumber()
    @Min(0)
    @Expose()
    requestedInSec: number;

    @ApiProperty({
        description: 'Requested out-point in seconds.',
        example: 45.2,
    })
    @IsNumber()
    @Min(0)
    @Expose()
    requestedOutSec: number;
}

export class AcceptReviewRangeDto {
    @ApiProperty({
        description: 'Start of the aligned range in seconds.',
        example: 12.0,
    })
    @IsNumber()
    @Min(0)
    @Expose()
    startSec: number;

    @ApiProperty({
        description: 'End of the aligned range in seconds.',
        example: 46.0,
    })
    @IsNumber()
    @Min(0)
    @Expose()
    endSec: number;
}

export class ReviewRangeResponseDto {
    @ApiProperty({ description: 'Session identifier.' })
    @Expose()
    sessionId: string;

    @ApiProperty({
        description: 'Requested range as provided by the client.',
        example: { startSec: 12.4, endSec: 45.2 },
    })
    @Expose()
    requestedRange: { startSec: number; endSec: number };

    @ApiProperty({
        description: 'Aligned range clamped to safe keyframe boundaries.',
        example: { startSec: 12.0, endSec: 46.0 },
    })
    @Expose()
    alignedRange: { startSec: number; endSec: number };
}
