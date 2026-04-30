import { IsBoolean, IsOptional, IsString, IsNotEmpty, ValidateIf } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EncryptionConfigDto {
    @ApiPropertyOptional({ default: true })
    @IsBoolean()
    @IsOptional()
    @Expose()
    enabled?: boolean;

    @ApiPropertyOptional({ example: 'https://myapp.example.com/keys/session-abc123' })
    @ValidateIf((o) => o.enabled !== false)
    @IsString()
    @IsNotEmpty({ message: 'keyUrl is required when encryption is enabled' })
    @Expose()
    keyUrl?: string;
}
