import {
    IsBoolean,
    IsNotEmpty,
    IsNumber,
    IsOptional,
    IsString,
    Max,
    Min,
} from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class S3ConfigDto {
    @ApiProperty({
        description:
            'S3-compatible endpoint hostname (without protocol). e.g. "s3.amazonaws.com", "minio.example.com", "abc123.r2.cloudflarestorage.com"',
        example: 'minio.example.com',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    endPoint: string;

    @ApiPropertyOptional({
        description: 'Endpoint port. Defaults to 443 (SSL) or 80 (non-SSL).',
        example: 9000,
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    @Max(65535)
    @Expose()
    port?: number;

    @ApiPropertyOptional({
        description: 'Use SSL/TLS for the connection. Defaults to true.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    useSSL?: boolean;

    @ApiProperty({
        description: 'S3 bucket name.',
        example: 'media-output',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    bucket: string;

    @ApiPropertyOptional({
        description: 'S3 region. Required for AWS S3, optional for others.',
        example: 'us-east-1',
    })
    @IsString()
    @IsOptional()
    @Expose()
    region?: string;

    @ApiProperty({
        description: 'S3 access key ID.',
        example: 'AKIAIOSFODNN7EXAMPLE',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    accessKey: string;

    @ApiProperty({
        description: 'S3 secret access key.',
        example: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    secretKey: string;

    @ApiPropertyOptional({
        description:
            'Optional prefix for all S3 object keys. e.g. "videos/project-1" will produce keys like "videos/project-1/master.m3u8".',
        example: 'videos/project-1',
    })
    @IsString()
    @IsOptional()
    @Expose()
    pathPrefix?: string;
}
