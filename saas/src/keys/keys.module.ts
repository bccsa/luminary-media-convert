import { Module } from '@nestjs/common';
import { KeysService } from './keys.service.js';
import { KeysController } from './keys.controller.js';
import { AdminKeysController } from './admin-keys.controller.js';

@Module({
    providers: [KeysService],
    controllers: [KeysController, AdminKeysController],
    exports: [KeysService],
})
export class KeysModule {}
