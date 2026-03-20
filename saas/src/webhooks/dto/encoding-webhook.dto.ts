import { IsString, IsOptional, IsNumber, IsArray, ValidateNested } from 'class-validator';
import { Expose, Type } from 'class-transformer';

class AnglePlaylistDto {
    @IsString() @Expose() name: string;
    @IsString() @Expose() key: string;
}

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
    @IsArray() @IsOptional() @ValidateNested({ each: true }) @Type(() => AnglePlaylistDto) @Expose() anglePlaylists?: AnglePlaylistDto[];
    @IsString() @IsOptional() @Expose() encryptionKeyHex?: string;
}
