import { IsBoolean, IsOptional, IsString, IsNotEmpty, ValidateIf } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class EncryptionConfigDto {
    @ApiPropertyOptional({
        description:
            'Whether HLS AES-128 encryption is enabled. Defaults to true.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    enabled?: boolean;

    @ApiPropertyOptional({
        description:
            'Production URL that will serve the AES-128 decryption key. ' +
            'Written into #EXT-X-KEY URI in HLS playlists uploaded to S3. ' +
            'Required when encryption is enabled.',
        example: 'https://myapp.example.com/keys/session-abc123',
    })
    @ValidateIf((o) => o.enabled !== false)
    @IsString()
    @IsNotEmpty({ message: 'keyUrl is required when encryption is enabled' })
    @Expose()
    keyUrl?: string;
}
