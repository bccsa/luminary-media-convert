import { PartialType } from '@nestjs/swagger';
import { CreateS3ConfigDto } from './create-s3-config.dto.js';

export class UpdateS3ConfigDto extends PartialType(CreateS3ConfigDto) {}
