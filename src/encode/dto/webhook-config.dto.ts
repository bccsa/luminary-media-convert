import { IsNotEmpty, IsString, IsUrl } from 'class-validator';
import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class WebhookConfigDto {
    @ApiProperty({
        description:
            'URL that will receive POST callbacks with encoding status updates.',
        example: 'https://myapp.example.com/webhooks/encode',
    })
    @IsUrl({ require_tld: false })
    @IsNotEmpty()
    @Expose()
    url: string;

    @ApiProperty({
        description:
            'Session token sent as X-Session-Token header on every webhook callback so the receiver can verify authenticity.',
        example: 'my-secret-session-token-abc123',
    })
    @IsString()
    @IsNotEmpty()
    @Expose()
    sessionToken: string;
}
