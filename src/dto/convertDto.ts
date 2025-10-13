import {
    IsNotEmpty,
    IsOptional,
    IsString,
    IsNumber,
    ValidateNested,
    IsNotEmptyObject,
    IsInstance,
    IsIn,
} from 'class-validator';
import { Expose, Type } from 'class-transformer';

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

    @IsString()
    @IsOptional()
    @Expose()
    error?: string;
}

export class MetadataDto {
    @IsString()
    @IsOptional()
    @Expose()
    originalName?: string;

    @IsString()
    @IsOptional()
    @Expose()
    title?: string;

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
    @Expose()
    @IsNotEmpty()
    @IsIn([
        'mp4',
        'mov',
        'avi',
        'mkv',
        'flv',
        'wmv',
        'webm',
        'mp3',
        'wav',
        'aac',
        'ogg',
        'opus',
    ])
    convertedFormat:
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
        | 'ogg'
        | 'opus';

    @IsNumber()
    @IsOptional()
    @Expose()
    bitrate?: number;
}

export class ConvertDto {
    @IsNotEmpty()
    @Expose()
    @IsInstance(File) // Using Object to allow both Buffer and File types
    file: File;

    @IsNotEmpty()
    @IsNotEmptyObject()
    @ValidateNested()
    @Type(() => MetadataDto)
    @Expose()
    metadata: MetadataDto;
}
