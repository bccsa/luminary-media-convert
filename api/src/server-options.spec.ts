import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { connect } from 'node:net';
import { SERVER_OPTIONS } from './server-options';

@Module({})
class EmptyModule {}

describe('SERVER_OPTIONS', () => {
    it('lets the server close while a request is still open, as a session page holds its event stream', async () => {
        const app = await NestFactory.create<NestExpressApplication>(EmptyModule, {
            ...SERVER_OPTIONS,
            logger: false,
        });
        await app.listen(0, '127.0.0.1');
        const address = app.getHttpServer().address();
        const port = typeof address === 'object' && address ? address.port : 0;

        // A request whose headers never finish: the server holds the connection
        // open, as it does for an event stream that is never ended.
        const socket = connect(port, '127.0.0.1');
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n');
        await new Promise((resolve) => setTimeout(resolve, 100));

        const closed = app.close().then(() => 'closed');
        const timedOut = new Promise((resolve) => setTimeout(() => resolve('still open'), 3000));
        expect(await Promise.race([closed, timedOut])).toBe('closed');
        socket.destroy();
    }, 15000);
});
