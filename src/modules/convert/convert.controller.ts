import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ConvertService } from './convert.service.js';

@Controller('api')
export class ConvertController {
    constructor(private readonly convert: ConvertService) {}

    // POST /api/convert - create a new conversion
    @Post('/convert/:dispatchId')
    async scheduleConversion(
        @Param('dispatchId') dispatchId: string,
        @Body('meta-data') schema: any
    ) {
        return dispatchId;
    }

    // GET /api/convert/:dispatchId - health check endpoint
    @Get('/convert/:dispatchId')
    getConverted(@Param('dispatchId') dispatchId: string) {
        return { status: 'ok', dispatchId };
    }
}
