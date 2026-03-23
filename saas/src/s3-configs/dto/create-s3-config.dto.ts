import { IsString, IsOptional, IsNumber, IsBoolean, IsUrl, MinLength, MaxLength, ValidateIf } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateS3ConfigDto {
    @ApiProperty() @IsString() @MinLength(1) @MaxLength(100) name: string;
    @ApiProperty() @IsString() @MinLength(1) endPoint: string;
    @ApiPropertyOptional() @IsOptional() @IsNumber() port?: number;
    @ApiPropertyOptional() @IsOptional() @IsBoolean() useSSL?: boolean;
    @ApiProperty() @IsString() @MinLength(1) bucket: string;
    @ApiPropertyOptional() @IsOptional() @IsString() region?: string;
    @ApiProperty() @IsString() @MinLength(1) accessKey: string;
    @ApiProperty() @IsString() @MinLength(1) secretKey: string;
    @ApiPropertyOptional({ description: 'Public base URL for accessing objects (e.g. custom domain on R2). Object keys are appended directly.' })
    @IsOptional() @ValidateIf((_, value) => value !== '') @IsUrl({ require_tld: false }) publicUrl?: string;
}
