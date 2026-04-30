import { ApiProperty } from '@nestjs/swagger';

export class SaasSessionResponseDto {
    @ApiProperty() sessionId: string;
    @ApiProperty() encodingApiUrl: string;
    @ApiProperty() sessionToken: string;
    @ApiProperty() maxUploadSize: number;
}
