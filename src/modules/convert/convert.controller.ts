import {
    Body,
    Controller,
    Get,
    Param,
    Post,
    Query,
    UploadedFile,
    UseInterceptors,
    BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConvertService } from './convert.service';
import { ConvertDto, MetadataDto } from '../../dto/convertDto';
import { getDispatch } from '../../utils/dispatcher';
import { QueueItemDto } from '../../dto/queueDto';
import { ParseMetadataPipe } from '../../pipes/parse-metadata.pipe';

@Controller('api')
export class ConvertController {
    constructor(private readonly convert: ConvertService) {}

    // POST /api/convert - create a new conversion
    // POST /api/convert - create a new conversion
    @Post('/convert/:dispatchId')
    @UseInterceptors(
        FileInterceptor('file', {
            limits: {
                fileSize: 1024 * 1024 * 1024, // 1GB limit; adjust as needed
            },
        })
    )
    async queueConversion(
        @Param('dispatchId') dispatchId: string,
        @UploadedFile() uploaded: any,
        @Body('metadata') metadataRaw: any
    ) {
        if (!uploaded || !uploaded.buffer || uploaded.size === 0) {
            throw new BadRequestException('A non-empty file is required');
        }

        // Parse metadata string (or object) before validation
        const metadata: MetadataDto = new ParseMetadataPipe().transform(
            metadataRaw
        );

        // Build ConvertDto for service
        const dto: ConvertDto = {
            file: uploaded,
            metadata: {
                ...metadata,
                originalName:
                    metadata?.originalName ||
                    uploaded.originalname ||
                    'unknown',
            },
        } as ConvertDto;

        return await this.convert.queueConversion(dispatchId, dto);
    }

    // GET /api/convert/:dispatchId - health check endpoint
    @Get('/convert/:dispatchId')
    getConverted(
        @Param('dispatchId') dispatchId: string,
        @Query('status') status: string
    ): Array<QueueItemDto & { file?: File | Buffer }> {
        return getDispatch(dispatchId, (status as any) || 'all');
    }
}
