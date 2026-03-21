import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module.js';
import dotenv from 'dotenv';

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
            'apikey',
        )
        .addBearerAuth(
            {
                type: 'http',
                scheme: 'bearer',
                description:
                    'Session token (sess_*) returned from the session creation endpoint.',
            },
        )
        .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    // CORS: The Encoding API is a public, token-authenticated service
    // (X-API-Key / Bearer session tokens). No cookies or ambient credentials
    // are used, so allowing all origins is safe — the same pattern used by
    // Stripe, GitHub, and other public APIs with bearer auth.
    //
    // /api/tus routes are raw Express handlers proxied to the tusd Go binary,
    // which manages its own CORS (including tus-specific protocol headers).
    // NestJS CORS middleware also runs on those routes but tusd's response
    // headers take precedence since it writes them directly.
    app.enableCors({
        origin: true,
        credentials: false,
        allowedHeaders: [
            'Content-Type',
            'Authorization',
            'X-API-Key',
            // Tus protocol headers — required for resumable uploads via /api/tus
            'Tus-Resumable',
            'Upload-Length',
            'Upload-Offset',
            'Upload-Metadata',
            'Upload-Defer-Length',
            'Upload-Concat',
        ],
        exposedHeaders: [
            'Location',
            'Tus-Resumable',
            'Tus-Version',
            'Tus-Extension',
            'Tus-Max-Size',
            'Upload-Length',
            'Upload-Offset',
            'Upload-Metadata',
        ],
        maxAge: 600,
    });

    const port = process.env.PORT ?? 3000;
    await app.listen(port);
    console.log(`Luminary Media Convert running on port ${port}`);
    console.log(`API docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
