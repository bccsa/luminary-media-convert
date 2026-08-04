// CI/CD verification: confirm push-to-main auto-deploys api-staging (2026-07-15). Safe to remove.
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module.js';
import dotenv from 'dotenv';
import { CORS_OPTIONS } from './cors.config.js';

dotenv.config();

const helmetMiddleware = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
        },
    },
});

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    // Skip helmet for /api/tus — tusd manages its own headers.
    app.use((req: Request, res: Response, next: NextFunction) => {
        if (req.path.startsWith('/api/tus')) {
            return next();
        }
        helmetMiddleware(req, res, next);
    });

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
        .addApiKey(
            {
                type: 'apiKey',
                in: 'header',
                name: 'X-API-Key',
                description:
                    'Master API key or externally-managed API key validated via webhook.',
            },
            'apikey'
        )
        .addBearerAuth({
            type: 'http',
            scheme: 'bearer',
            description:
                'Session token (sess_*) returned from the session creation endpoint.',
        })
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    app.enableCors(CORS_OPTIONS);

    const port = process.env.PORT ?? 3000;
    // Defaults to all interfaces, as the containerised deployment needs.
    // Set BIND_HOST=127.0.0.1 to keep the service loopback-only (desktop).
    const host = process.env.BIND_HOST ?? '0.0.0.0';
    await app.listen(port, host);
    console.log(`Luminary Media Convert running on ${host}:${port}`);
    console.log(`API docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
