import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class S3ConfigResponseDto {
    @ApiProperty() id: string;
    @ApiProperty() name: string;
    @ApiProperty() endPoint: string;
    @ApiPropertyOptional() port?: number;
    @ApiPropertyOptional() useSSL?: boolean;
    @ApiProperty() bucket: string;
    @ApiPropertyOptional() region?: string;
    @ApiProperty({ description: 'Masked in list responses, decrypted in detail' })
    accessKey: string;
    @ApiProperty({ description: 'Masked in list responses, decrypted in detail' })
    secretKey: string;
    @ApiPropertyOptional({ description: 'Public base URL for accessing objects (e.g. custom domain on R2)' })
    publicUrl?: string;
    @ApiProperty() createdAt: string;
    @ApiProperty() updatedAt: string;
}
