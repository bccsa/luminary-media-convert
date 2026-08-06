import { IsBoolean, IsOptional, IsString } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { LUMINARY_KEY_PLACEHOLDER_URI } from '@luminary-media-converter/hls';

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
            'URL that will serve the AES-128 decryption key. ' +
            'Written into #EXT-X-KEY URI in HLS playlists uploaded to S3. ' +
            `Optional — when omitted, the placeholder "${LUMINARY_KEY_PLACEHOLDER_URI}" ` +
            'is written instead and players are expected to swap in the key client-side.',
        example: 'https://myapp.example.com/keys/session-abc123',
    })
    @IsString()
    @IsOptional()
    @Expose()
    keyUrl?: string;
}
