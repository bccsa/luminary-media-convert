import { ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsString,
    IsOptional,
    IsEnum,
    IsInt,
    Min,
    IsNotEmpty,
} from 'class-validator';

export class UpdateUserDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsNotEmpty()
    name?: string;

    @ApiPropertyOptional({ enum: ['user', 'admin'] })
    @IsOptional()
    @IsEnum(['user', 'admin'])
    role?: 'user' | 'admin';

    @ApiPropertyOptional({ description: 'Session retention override in days (null to use default)', nullable: true })
    @IsOptional()
    @IsInt()
    @Min(1)
    sessionRetentionDaysOverride?: number | null;
}
