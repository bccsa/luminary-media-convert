import { Module } from '@nestjs/common';
import { ConvertModule } from './modules/convert/convert.module.js';

@Module({
  imports: [ConvertModule],
})
export class AppModule {}
