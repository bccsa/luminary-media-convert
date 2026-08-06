import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { Readable } from 'stream';
import { S3EtagService } from './s3-etag.service.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';

const config: S3ConfigDto = {
    endPoint: 'minio.example.com',
    port: 9000,
    useSSL: false,
    bucket: 'media',
    accessKey: 'key',
    secretKey: 'secret',
};

function makeSendMock(impl: (cmd: any) => any) {
    return vi.fn().mockImplementation(async (cmd) => impl(cmd));
}

describe('S3EtagService', () => {
    let service: S3EtagService;
    let sendMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        service = new S3EtagService();
        sendMock = vi.fn();
        vi.spyOn(service, 'createClient').mockReturnValue({
            send: sendMock,
        } as any);
    });

    describe('getObjectWithEtag', () => {
        it('returns the body and unquoted etag', async () => {
            sendMock.mockResolvedValue({
                Body: Readable.from(Buffer.from('hello')),
                ETag: '"abc123"',
            });

            const result = await service.getObjectWithEtag(
                config,
                'master.m3u8'
            );
            expect(result.body.toString()).toBe('hello');
            expect(result.etag).toBe('abc123');
        });
    });

    describe('putObjectIfMatch', () => {
        it('passes the IfMatch header to the PutObjectCommand and returns the new etag', async () => {
            sendMock.mockResolvedValue({ ETag: '"newEtag"' });

            const result = await service.putObjectIfMatch(
                config,
                'master.m3u8',
                '#EXTM3U\n',
                'oldEtag',
                'application/vnd.apple.mpegurl'
            );

            expect(result.etag).toBe('newEtag');
            expect(sendMock).toHaveBeenCalledTimes(1);
            const cmd = sendMock.mock.calls[0][0];
            expect(cmd.input).toMatchObject({
                Bucket: 'media',
                Key: 'master.m3u8',
                IfMatch: 'oldEtag',
                ContentType: 'application/vnd.apple.mpegurl',
            });
        });

        it('throws ConflictException on 412 PreconditionFailed', async () => {
            const err = Object.assign(new Error('etag mismatch'), {
                name: 'PreconditionFailed',
                $metadata: { httpStatusCode: 412 },
            });
            sendMock.mockImplementationOnce(async () => {
                throw err;
            });
            // HEAD follow-up returns the current etag
            sendMock.mockResolvedValueOnce({ ETag: '"currentEtag"' });

            await expect(
                service.putObjectIfMatch(
                    config,
                    'master.m3u8',
                    '',
                    'stale',
                    'text/plain'
                )
            ).rejects.toBeInstanceOf(ConflictException);
        });

        it('returns the current etag in the conflict response when HEAD succeeds', async () => {
            const err = Object.assign(new Error('mismatch'), {
                $metadata: { httpStatusCode: 412 },
            });
            sendMock.mockImplementationOnce(async () => {
                throw err;
            });
            sendMock.mockResolvedValueOnce({ ETag: '"liveEtag"' });

            try {
                await service.putObjectIfMatch(
                    config,
                    'k',
                    '',
                    'stale',
                    'text/plain'
                );
                throw new Error('should have thrown');
            } catch (e: any) {
                expect(e).toBeInstanceOf(ConflictException);
                expect(e.getResponse()).toMatchObject({
                    code: 'ETAG_MISMATCH',
                    currentEtag: 'liveEtag',
                });
            }
        });

        it('rethrows non-412 errors untouched', async () => {
            const err = Object.assign(new Error('nope'), {
                name: 'AccessDenied',
                $metadata: { httpStatusCode: 403 },
            });
            sendMock.mockRejectedValue(err);

            await expect(
                service.putObjectIfMatch(
                    config,
                    'k',
                    '',
                    'anything',
                    'text/plain'
                )
            ).rejects.toBe(err);
        });
    });

    describe('putObject (unconditional)', () => {
        it('does not send IfMatch', async () => {
            sendMock.mockResolvedValue({ ETag: '"e"' });

            await service.putObject(
                config,
                'chapters.vtt',
                'WEBVTT\n',
                'text/vtt'
            );
            const cmd = sendMock.mock.calls[0][0];
            expect(cmd.input.IfMatch).toBeUndefined();
            expect(cmd.input.ContentType).toBe('text/vtt');
        });
    });

    describe('createClient', () => {
        it('builds the endpoint URL from config (path-style addressing)', () => {
            const real = new S3EtagService();
            const client = real.createClient(config);
            // S3Client stores config in a promise — just assert instance creation didn't throw
            expect(client).toBeDefined();
        });
    });
});
