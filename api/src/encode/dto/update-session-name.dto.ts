import { IsString, MaxLength } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateSessionNameDto {
    @ApiProperty({
        description:
            'New label for the session. An empty string clears it, leaving the session unnamed rather than named "".',
        example: 'Interview — final cut',
    })
    @IsString()
    @MaxLength(200)
    @Expose()
    name: string;
}
