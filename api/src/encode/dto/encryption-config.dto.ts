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

    @ApiPropertyOptional({
        description:
            'Encrypt master/media playlists and WebVTT sidecars with the session ' +
            'key (LMCENC01 format, see docs/encrypted-sidecar-format.md). ' +
            'Segments are already AES-128 encrypted when encryption is enabled; ' +
            'this extends coverage to the text assets, so generic HLS tooling ' +
            'cannot read the stream layout, chapter titles or subtitles from the ' +
            'bucket. Encrypted objects upload as application/octet-stream under ' +
            'their existing keys and extensions. Defaults to false.',
        default: false,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    encryptPlaylists?: boolean;
}
