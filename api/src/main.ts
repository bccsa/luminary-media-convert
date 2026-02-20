import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import dotenv from 'dotenv';

dotenv.config();

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

    // Enable graceful shutdown hooks (onModuleDestroy, etc.)
    app.enableShutdownHooks();

    // Swagger / OpenAPI documentation
    const config = new DocumentBuilder()
        .setTitle('Luminary Media Convert')
        .setDescription(
            'HLS/ABR media encoding service. Create encoding sessions, upload media files, ' +
            'and receive webhook callbacks with progress updates and S3 output locations.'
        )
        .setVersion('2.0.0')
        .addBasicAuth({
            type: 'http',
            scheme: 'basic',
            description:
                'Basic authentication with username and password configured on the server.',
        })
        .addBearerAuth({
            type: 'http',
            scheme: 'bearer',
            description:
                'Upload token returned from the session creation endpoint.',
        })
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    const port = process.env.PORT ?? 3000;
    await app.listen(port);
    console.log(`Luminary Media Convert running on port ${port}`);
    console.log(`API docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
