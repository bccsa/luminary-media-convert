import {
    IsBoolean,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    Min,
    ValidateNested,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { S3ConfigDto } from './s3-config.dto.js';
import { EncryptionConfigDto } from './encryption-config.dto.js';

export class CreateSaasSessionDto {
    @ApiPropertyOptional({ default: 6 })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Expose()
    segmentDuration?: number;

    @ApiPropertyOptional({ default: true })
    @IsBoolean()
    @IsOptional()
    @Expose()
    byteRange?: boolean;

    @ApiPropertyOptional({ default: 500 })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Max(10240)
    @Expose()
    byteRangeMaxFileSizeMB?: number;

    @ApiPropertyOptional({ default: true })
    @IsBoolean()
    @IsOptional()
    @Expose()
    thumbnails?: boolean;

    @ApiProperty({ type: S3ConfigDto })
    @ValidateNested()
    @Type(() => S3ConfigDto)
    @Expose()
    s3: S3ConfigDto;

    @ApiPropertyOptional({ type: EncryptionConfigDto })
    @IsOptional()
    @ValidateNested()
    @Type(() => EncryptionConfigDto)
    @Expose()
    encryption?: EncryptionConfigDto;

    @ApiPropertyOptional({ description: 'ID of the saved S3 config used (for session history reference)' })
    @IsOptional()
    @IsString()
    @Expose()
    s3ConfigId?: string;
}
