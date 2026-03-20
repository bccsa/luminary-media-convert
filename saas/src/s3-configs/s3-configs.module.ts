import { Module } from '@nestjs/common';
import { S3ConfigsService } from './s3-configs.service.js';
import { S3ConfigsController } from './s3-configs.controller.js';

@Module({
    providers: [S3ConfigsService],
    controllers: [S3ConfigsController],
    exports: [S3ConfigsService],
})
export class S3ConfigsModule {}
