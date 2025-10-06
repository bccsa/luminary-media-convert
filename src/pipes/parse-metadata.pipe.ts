import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { MetadataDto } from '../dto/convertDto';

// Parses `metadata` coming from multipart/form-data which is often a JSON string,
// transforming it into an object so the global ValidationPipe can validate against MetadataDto.
@Injectable()
export class ParseMetadataPipe implements PipeTransform<any, MetadataDto> {
    transform(value: any): MetadataDto {
        if (value == null || value === '') {
            // Allow empty metadata; controller may supplement missing fields (e.g., originalName)
            return plainToInstance(
                MetadataDto,
                {},
                {
                    enableImplicitConversion: true,
                    exposeDefaultValues: true,
                }
            ) as unknown as MetadataDto;
        }

        let parsed: any = value;
        if (typeof value === 'string') {
            try {
                parsed = JSON.parse(value);
            } catch (e) {
                throw new BadRequestException('metadata must be valid JSON');
            }
        }

        // Return instance for ValidationPipe to validate
        return plainToInstance(MetadataDto, parsed, {
            enableImplicitConversion: true,
            exposeDefaultValues: true,
        }) as unknown as MetadataDto;
    }
}
