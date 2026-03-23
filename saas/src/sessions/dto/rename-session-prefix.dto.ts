import { IsNotEmpty, IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class RenameSessionPrefixDto {
    @ApiProperty({
        description: 'New path prefix for all session files',
        example: 'production/client-x/',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    newPathPrefix: string;
}
