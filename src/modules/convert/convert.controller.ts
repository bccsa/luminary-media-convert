import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ConvertService } from './convert.service';
import { ConvertDto } from 'src/dto/convertDto';

@Controller('api')
export class ConvertController {
    constructor(private readonly convert: ConvertService) {}

    // POST /api/convert - create a new conversion
    @Post('/convert/:dispatchId')
    async queueConversion(
        @Param('dispatchId') dispatchId: string,
        @Body() file: ConvertDto
    ) {
        return await this.convert.queueConversion(dispatchId, file);
    }

    // GET /api/convert/:dispatchId - health check endpoint
    @Get('/convert/:dispatchId')
    getConverted(@Param('dispatchId') dispatchId: string): Array<ConvertDto> {
        return [] as unknown as Array<ConvertDto>;
    }
}
