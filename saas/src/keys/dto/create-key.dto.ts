import { IsString, MinLength, MaxLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateKeyDto {
    @ApiProperty({ description: 'Display name for the API key', minLength: 1, maxLength: 100 })
    @IsString()
    @MinLength(1)
    @MaxLength(100)
    name: string;

    @ApiProperty({ description: 'SHA-256 hex digest of the raw key (generated client-side)' })
    @IsString()
    @Matches(/^[0-9a-f]{64}$/, { message: 'keyHash must be a 64-character hex string' })
    keyHash: string;

    @ApiProperty({ description: 'First 12 characters of the raw key (for display)' })
    @IsString()
    @MinLength(4)
    @MaxLength(20)
    prefix: string;
}
