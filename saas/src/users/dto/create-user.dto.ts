import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
    IsString,
    IsNotEmpty,
    IsEmail,
    IsOptional,
    IsEnum,
} from 'class-validator';

export class CreateUserDto {
    @ApiProperty() @IsEmail() email: string;
    @ApiProperty() @IsString() @IsNotEmpty() name: string;
    @ApiPropertyOptional({ enum: ['user', 'admin'], default: 'user' })
    @IsOptional()
    @IsEnum(['user', 'admin'])
    role?: 'user' | 'admin';
}
