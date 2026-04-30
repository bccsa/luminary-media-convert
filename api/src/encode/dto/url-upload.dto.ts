import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UrlUploadDto {
    @ApiProperty({
        description:
            'HTTP/S URL to fetch the source media file from. The server will download the file directly into the session, replacing the tus upload step.',
        example: 'https://example.com/recording.mp4',
    })
    @IsUrl({
        protocols: ['http', 'https'],
        require_protocol: true,
        require_tld: false,
    })
    @MaxLength(2048)
    @Expose()
    url: string;

    @ApiPropertyOptional({
        description:
            'Optional filename override. If omitted, the server derives a name from the Content-Disposition header, the URL path, or the Content-Type.',
        example: 'meeting-2026-04-26.mp4',
    })
    @IsOptional()
    @IsString()
    @MaxLength(255)
    @Expose()
    filename?: string;
}
