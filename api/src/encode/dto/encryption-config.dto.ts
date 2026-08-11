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
            'Encrypt master/media playlists and WebVTT sidecars (chapters, and ' +
            'subtitles once they are written) with the same session key as the ' +
            'segments, in LMCENC01 format — see docs/encrypted-sidecar-format.md. ' +
            'Defaults to true whenever encryption is enabled: asking for an ' +
            'encrypted stream and publishing its layout, chapter titles and ' +
            'subtitles in the clear beside it protects very little. Encrypted ' +
            'objects upload as application/octet-stream under their existing ' +
            'keys and extensions.\n\n' +
            'Set false only for output that has to stay readable by players ' +
            'which cannot decrypt playlists — a stock hls.js or Video.js can ' +
            'play AES-128 segments, but cannot read an LMCENC playlist. ' +
            'Players built on @luminary-media-converter/player-core handle both.\n\n' +
            'This alone does not make output playable by a stock player: it ' +
            'gets one as far as parsing the playlist, where #EXT-X-KEY still ' +
            `names "${LUMINARY_KEY_PLACEHOLDER_URI}", a scheme no player can ` +
            'resolve. That needs keyUrl as well, pointing at something that ' +
            'serves the raw 16 key bytes — which this encoder is not, by ' +
            'design. Verified against a stock client; see Todo.md section 0a.',
        default: true,
    })
    @IsBoolean()
    @IsOptional()
    @Expose()
    encryptPlaylists?: boolean;
}
