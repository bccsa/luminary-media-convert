import { Injectable } from '@nestjs/common';
import { ConvertDto, ConvertResponseDto } from 'src/dto/convertDto';
import { queue } from 'src/utils/schedular';

@Injectable()
export class ConvertService {
    async queueConversion(
        dispatchId: string,
        files: Array<ConvertDto>
    ): Promise<Array<ConvertResponseDto>> {
        return await queue(dispatchId, files);
    }
}
