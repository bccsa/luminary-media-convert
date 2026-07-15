import { IsString, IsOptional, IsNumber, IsBoolean, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Payload for a connectivity test. Works for both the create and edit modals:
 * when `accessKey`/`secretKey` are omitted but `configId` is supplied (edit
 * mode where the user did not re-type the secret), the stored credentials for
 * that config are used instead.
 */
export class TestS3ConfigDto {
    @ApiPropertyOptional({
        description:
            'Existing config id (edit mode). Stored credentials are used when accessKey/secretKey are omitted.',
    })
    @IsOptional()
    @IsString()
    configId?: string;

    @ApiProperty() @IsString() @MinLength(1) endPoint: string;
    @ApiPropertyOptional() @IsOptional() @IsNumber() port?: number;
    @ApiPropertyOptional() @IsOptional() @IsBoolean() useSSL?: boolean;
    @ApiProperty() @IsString() @MinLength(1) bucket: string;
    @ApiPropertyOptional() @IsOptional() @IsString() region?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() accessKey?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() secretKey?: string;
}
