import { IsString, IsOptional } from 'class-validator';
import { Expose } from 'class-transformer';

export class AuthorizeRequestDto {
    @IsString() @Expose() action: string;
    @IsString() @IsOptional() @Expose() userId?: string;
    @IsString() @IsOptional() @Expose() sessionId?: string;
    @IsOptional() @Expose() metadata?: unknown;
}
