import { Injectable } from '@nestjs/common';
import { ConvertDto, ConvertResponseDto } from '../../dto/convertDto';
import { queue } from '../../utils/schedular';

@Injectable()
export class ConvertService {
    async queueConversion(
        dispatchId: string,
        file: ConvertDto
    ): Promise<ConvertResponseDto> {
        return await queue(dispatchId, file);
    }
}
