import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';

describe('Encode API (e2e)', () => {
    let app: INestApplication;

    beforeEach(async () => {
        process.env.AUTH_USERNAME = 'testuser';
        process.env.AUTH_PASSWORD = 'testpass';

        const moduleFixture: TestingModule =
            await Test.createTestingModule({
                imports: [AppModule.forRoot()],
            }).compile();

        app = moduleFixture.createNestApplication();
        app.useGlobalPipes(
            new ValidationPipe({
                transform: true,
                whitelist: true,
                forbidNonWhitelisted: true,
                transformOptions: {
                    enableImplicitConversion: true,
                },
            })
        );
        await app.init();
    });

    afterEach(async () => {
        await app.close();
    });

    it('POST /api/sessions without auth should return 401', () => {
        return request(app.getHttpServer())
            .post('/api/sessions')
            .send({})
            .expect(401);
    });

    it('GET /api/sessions/:id with unknown id should return 404', () => {
        const basicAuth = Buffer.from('testuser:testpass').toString(
            'base64'
        );
        return request(app.getHttpServer())
            .get('/api/sessions/nonexistent-id')
            .set('Authorization', `Basic ${basicAuth}`)
            .expect(404);
    });
});
