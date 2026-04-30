import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserResponseDto {
    @ApiProperty() id: string;
    @ApiProperty() email: string;
    @ApiProperty() name: string;
    @ApiProperty({ enum: ['user', 'admin'] }) role: 'user' | 'admin';
    @ApiProperty({ enum: ['active', 'disabled', 'pending_verification'] })
    status: 'active' | 'disabled' | 'pending_verification';
    @ApiPropertyOptional({ nullable: true }) lastLoginAt: string | null;
    @ApiPropertyOptional({ nullable: true }) lastApiAccessAt: string | null;
    @ApiProperty() createdAt: string;
    @ApiProperty() updatedAt: string;
}
