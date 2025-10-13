import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MetadataDto } from '../dto/convertDto';

// Parses `metadata` coming from multipart/form-data which is often a JSON string,
// transforming it into an object so the global ValidationPipe can validate against MetadataDto.
@Injectable()
export class ParseMetadataPipe implements PipeTransform<any, MetadataDto> {
    transform(value: any): MetadataDto {
        if (value == null || value === '') {
            throw new BadRequestException('metadata is required');
        }

        let parsed: any = value;
        if (typeof value === 'string') {
            try {
                parsed = JSON.parse(value);
            } catch (e) {
                throw new BadRequestException('metadata must be valid JSON');
            }
        }

        // Transform and validate now to ensure it matches the DTO contract
        const instance = plainToInstance(MetadataDto, parsed, {
            enableImplicitConversion: true,
            exposeDefaultValues: true,
            excludeExtraneousValues: true, // remove props not decorated with @Expose
        });

        const errors = validateSync(instance as object, {
            whitelist: true, // strip non-decorated properties during validation
            forbidNonWhitelisted: false, // we already exclude via class-transformer
        });

        if (errors.length) {
            const messages = errors
                .map((e) => Object.values(e.constraints || {}).join(', '))
                .filter(Boolean);
            throw new BadRequestException(
                messages.length
                    ? `Invalid metadata: ${messages.join('; ')}`
                    : 'Invalid metadata payload.'
            );
        }

        return instance as MetadataDto;
    }
}
