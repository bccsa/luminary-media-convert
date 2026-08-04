import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
    const app = await NestFactory.create(AppModule, {
        logger: ['log', 'error', 'warn', 'debug', 'verbose'],
    });

    app.use(helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:'],
            },
        },
    }));

    app.useGlobalPipes(
        new ValidationPipe({
            transform: true,
            whitelist: true,
            forbidNonWhitelisted: true,
            transformOptions: { enableImplicitConversion: true },
        }),
    );

    app.enableShutdownHooks();

    if (process.env.ENABLE_SWAGGER === 'true') {
        const config = new DocumentBuilder()
            .setTitle('Luminary SaaS')
            .setDescription(
                'SaaS service for user management, API keys, session history, and billing.',
            )
            .setVersion('1.0.0')
            .addBearerAuth(
                {
                    type: 'http',
                    scheme: 'bearer',
                    bearerFormat: 'JWT',
                    description:
                        'Auth0 access token (JWT). Obtain via Auth0 login flow.',
                },
                'auth0',
            )
            .build();

        const document = SwaggerModule.createDocument(app, config);
        SwaggerModule.setup('saas/docs', app, document);
    }

    const corsOrigin = process.env.CORS_ORIGIN;
    if (!corsOrigin) {
        console.warn(
            'CORS_ORIGIN not set — defaulting to http://localhost:5173. Set CORS_ORIGIN for production.',
        );
    }
    const origin = corsOrigin
        ? corsOrigin.includes(',')
            ? corsOrigin.split(',').map((o) => o.trim())
            : corsOrigin
        : 'http://localhost:5173';
    app.enableCors({ origin });

    const port = process.env.PORT ?? 3001;
    // Defaults to all interfaces, as the containerised deployment needs.
    // Set BIND_HOST=127.0.0.1 to keep the service loopback-only (desktop).
    const host = process.env.BIND_HOST ?? '0.0.0.0';
    await app.listen(port, host);
    console.log(`Luminary SaaS running on ${host}:${port}`);
    if (process.env.ENABLE_SWAGGER === 'true') {
        console.log(`API docs available at http://localhost:${port}/saas/docs`);
    }
}

bootstrap();
