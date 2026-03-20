import { IsString, IsOptional, IsNumber, IsArray } from 'class-validator';
import { Expose } from 'class-transformer';

export class EncodingWebhookDto {
    @IsString() @Expose() sessionId: string;
    @IsString() @Expose() status: string;
    @IsNumber() @IsOptional() @Expose() progress?: number;
    @IsNumber() @IsOptional() @Expose() queuePosition?: number;
    @IsString() @IsOptional() @Expose() message?: string;
    @IsString() @IsOptional() @Expose() error?: string;
    @IsArray() @IsOptional() @Expose() files?: string[];
    @IsString() @IsOptional() @Expose() masterPlaylist?: string;
    @IsString() @IsOptional() @Expose() thumbnailsVtt?: string;
    @IsArray() @IsOptional() @Expose() anglePlaylists?: Array<{ name: string; key: string }>;
    @IsString() @IsOptional() @Expose() encryptionKeyHex?: string;
}
