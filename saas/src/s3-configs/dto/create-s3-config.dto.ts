import { IsString, IsOptional, IsNumber, IsBoolean, MinLength, MaxLength } from 'class-validator';
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
}
