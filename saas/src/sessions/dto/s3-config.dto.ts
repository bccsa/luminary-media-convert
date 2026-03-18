import {
    IsBoolean,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
} from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class S3ConfigDto {
    @ApiProperty({ example: 'minio.example.com' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    endPoint: string;

    @ApiPropertyOptional({ example: 9000 })
    @IsNumber()
    @IsOptional()
    @Expose()
    port?: number;

    @ApiPropertyOptional({ default: true })
    @IsBoolean()
    @IsOptional()
    @Expose()
    useSSL?: boolean;

    @ApiProperty({ example: 'media-output' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    bucket: string;

    @ApiPropertyOptional({ example: 'us-east-1' })
    @IsString()
    @IsOptional()
    @Expose()
    region?: string;

    @ApiProperty({ example: 'AKIAIOSFODNN7EXAMPLE' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    accessKey: string;

    @ApiProperty({ example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    secretKey: string;

    @ApiPropertyOptional({ example: 'videos/project-1' })
    @IsString()
    @IsOptional()
    @Expose()
    pathPrefix?: string;
}
