import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { initScheduler } from './utils/schedular';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

initScheduler();
