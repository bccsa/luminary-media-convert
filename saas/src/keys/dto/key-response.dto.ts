import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class KeyResponseDto {
    @ApiProperty() id: string;
    @ApiProperty() name: string;
    @ApiProperty() prefix: string;
    @ApiProperty() status: string;
    @ApiPropertyOptional() lastUsedAt?: string;
    @ApiProperty() createdAt: string;
}
