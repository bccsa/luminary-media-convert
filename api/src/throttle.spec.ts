import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { SkipAllThrottles, THROTTLERS } from './throttle.js';

@Controller('exempt')
@SkipAllThrottles()
class ExemptController {
    @Get()
    get() {
        return 'ok';
    }
}

@Controller('limited')
class LimitedController {
    @Get()
    get() {
        return 'ok';
    }
}

/**
 * Status codes of `count` requests in quick succession, as the trim timeline
 * sends them. In waves, because macOS queues only 128 pending connections.
 */
async function burst(app: INestApplication, path: string, count: number) {
    const base = await app.getUrl();
    const statuses: number[] = [];
    for (let sent = 0; sent < count; sent += 25) {
        const wave = Math.min(25, count - sent);
        const responses = await Promise.all(
            Array.from({ length: wave }, () => fetch(`${base}${path}`))
        );
        statuses.push(...responses.map((response) => response.status));
    }
    return statuses;
}

describe('SkipAllThrottles', () => {
    let app: INestApplication;
    const overLimit = THROTTLERS[0]!.limit + 50;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [ThrottlerModule.forRoot({ throttlers: THROTTLERS })],
            controllers: [ExemptController, LimitedController],
            providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
        }).compile();
        app = moduleRef.createNestApplication();
        await app.listen(0, '127.0.0.1');
    });

    afterAll(async () => {
        await app.close();
    });

    it('lets a burst past every limit through', async () => {
        const statuses = await burst(app, '/exempt', overLimit);
        expect(statuses.filter((status) => status !== 200)).toEqual([]);
    });

    it('leaves the limits on routes it does not mark', async () => {
        const statuses = await burst(app, '/limited', overLimit);
        expect(statuses).toContain(429);
    });
});
