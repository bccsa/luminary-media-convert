import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class ValidateKeyDto {
    @ApiProperty() @IsString() apiKey: string;
}
