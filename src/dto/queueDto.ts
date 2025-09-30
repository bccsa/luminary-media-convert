import { IsNotEmpty, IsString, ValidateNested } from 'class-validator';
import { Expose } from 'class-transformer';
import { MetadataDto } from './convertDto';

/**
 * Base Data Transfer Object class for all database storable data transfer objects
 */
export class QueueItemDto {
    @IsNotEmpty()
    @Expose()
    dispatchId: string;

    @IsNotEmpty()
    @Expose()
    @IsString()
    status: 'pending' | 'processing' | 'completed' | 'failed';

    @IsNotEmpty()
    @ValidateNested()
    @Expose()
    metadata: MetadataDto;

    @IsNotEmpty()
    @Expose()
    @IsString()
    filePath: string;

    @IsNotEmpty()
    @Expose()
    @IsString()
    id: string;
}
