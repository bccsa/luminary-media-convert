import { IsNotEmpty, IsOptional, IsString, IsNumber } from 'class-validator';
import { Expose } from 'class-transformer';

export class ConvertDto {
    @IsNotEmpty()
    @Expose()
    file: Buffer;

    @IsNotEmpty()
    @Expose()
    metadata: MetadataDto;
}

export class ConvertResponseDto {
    @IsString()
    @IsNotEmpty()
    @Expose()
    id: string;

    @IsString()
    @IsNotEmpty()
    @Expose()
    fileName: string;

    @IsString()
    @IsNotEmpty()
    @Expose()
    status: 'pending' | 'processing' | 'completed' | 'failed' | 'invalid';
}

export class MetadataDto {
    @IsString()
    @IsNotEmpty()
    @Expose()
    originalName: string;

    @IsString()
    @IsNotEmpty()
    @Expose()
    title: string;

    @IsString()
    @IsOptional()
    @Expose()
    description?: string;

    @IsString()
    @IsOptional()
    @Expose()
    author?: string;

    @IsString()
    @IsOptional()
    @Expose()
    copyright?: string;

    @IsString()
    @IsNotEmpty()
    @Expose()
    format:
        | 'mp4'
        | 'mov'
        | 'avi'
        | 'mkv'
        | 'flv'
        | 'wmv'
        | 'webm'
        | 'mp3'
        | 'wav'
        | 'aac'
        | 'ogg';

    @IsNumber()
    @IsOptional()
    @Expose()
    bitrate?: number;
}
