import { IsNotEmpty, IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class MoveSessionFilesDto {
    @ApiProperty({ description: 'Target S3 config ID to move files to' })
    @IsString()
    @IsNotEmpty()
    @Expose()
    targetS3ConfigId: string;

    @ApiProperty({
        description: 'Path prefix for files in the target bucket',
        example: 'videos/project-1/',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    newPathPrefix: string;
}
