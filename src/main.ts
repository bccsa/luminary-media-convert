import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { initScheduler } from './utils/schedular';
import { initDispatcher } from './utils/dispatcher';

async function bootstrap() {
    const app = await NestFactory.create(AppModule);
    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: true },
        })
    );
    await app.listen(process.env.PORT ?? 3000);
}
bootstrap();

initScheduler();
initDispatcher();
