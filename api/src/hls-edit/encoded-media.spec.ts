import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { EDITED_CACHE_CONTROL, HlsEditService } from './hls-edit.service.js';
import {
    decryptTextAsset,
    encryptTextAsset,
    keyFromHex,
} from '../encode/services/lmcenc.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';

const MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Francais",LANGUAGE="fr",DEFAULT=YES,URI="stream_1_Francais/playlist.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aud"',
    'stream_0/playlist.m3u8',
    '',
].join('\n');
const RENAMED = MASTER.replace(
    'NAME="Francais",LANGUAGE="fr"',
    'NAME="Français",LANGUAGE="fra"'
);
const EDIT = {
    from: { language: 'fr', name: 'Francais' },
    to: { language: 'fra', name: 'Français' },
};

const KEY = '000102030405060708090a0b0c0d0e0f';
const s3: S3ConfigDto = {
    endPoint: 'r2.example.com',
    bucket: 'media',
    accessKey: 'k',
    secretKey: 's',
};
const MASTER_KEY = 'posts/p1/s1/master.m3u8';

function makeEtag(stored: Buffer | string, listed: string[] = []) {
    return {
        getObjectWithEtag: vi.fn().mockResolvedValue({
            body: Buffer.from(stored as never),
            etag: 'v1',
        }),
        putObjectIfMatch: vi.fn().mockResolvedValue({ etag: 'v2' }),
        putObjectIfAbsent: vi.fn().mockResolvedValue(true),
        putObject: vi.fn(),
        createClient: vi.fn(() => ({
            send: vi.fn().mockResolvedValue({
                Contents: listed.map((Key) => ({ Key })),
            }),
        })),
    };
}

describe('HlsEditService — an existing video', () => {
    let etag: ReturnType<typeof makeEtag>;
    let service: HlsEditService;

    describe('readEncodedMedia', () => {
        it('lists the tracks and chapter languages, and says it is plaintext', async () => {
            etag = makeEtag(MASTER, [
                MASTER_KEY,
                'posts/p1/s1/chapters/en.vtt',
                'posts/p1/s1/chapters/fr.vtt',
            ]);
            service = new HlsEditService(etag as never);
            const media = await service.readEncodedMedia(s3, MASTER_KEY);
            expect(media).toEqual({
                tracks: [
                    {
                        language: 'fr',
                        name: 'Francais',
                        groups: ['aud'],
                        default: true,
                    },
                ],
                chapterLanguages: ['en', 'fr'],
                etag: 'v1',
                encrypted: false,
            });
        });

        it('decrypts an encrypted master with the key, and says it is encrypted', async () => {
            etag = makeEtag(encryptTextAsset(MASTER, keyFromHex(KEY)));
            service = new HlsEditService(etag as never);
            const media = await service.readEncodedMedia(s3, MASTER_KEY, KEY);
            expect(media.encrypted).toBe(true);
            expect(media.tracks[0].name).toBe('Francais');
        });

        it('refuses an encrypted master without its key', async () => {
            etag = makeEtag(encryptTextAsset(MASTER, keyFromHex(KEY)));
            service = new HlsEditService(etag as never);
            await expect(
                service.readEncodedMedia(s3, MASTER_KEY)
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('saveAudioTracks', () => {
        it('writes the renamed master in plaintext, only over the version read, keeps the original, and asks the CDN to check back', async () => {
            etag = makeEtag(MASTER);
            service = new HlsEditService(etag as never);
            await service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT]);

            expect(etag.putObjectIfAbsent).toHaveBeenCalledWith(
                s3,
                `${MASTER_KEY}.orig`,
                Buffer.from(MASTER),
                'application/vnd.apple.mpegurl'
            );
            expect(etag.putObjectIfMatch).toHaveBeenCalledWith(
                s3,
                MASTER_KEY,
                RENAMED,
                'v1',
                'application/vnd.apple.mpegurl',
                { cacheControl: EDITED_CACHE_CONTROL }
            );
        });

        it('writes an encrypted master back encrypted with the same key, and backs up the encrypted original', async () => {
            const stored = encryptTextAsset(MASTER, keyFromHex(KEY));
            etag = makeEtag(stored);
            service = new HlsEditService(etag as never);
            await service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT], KEY);

            expect(etag.putObjectIfAbsent.mock.calls[0][2]).toEqual(stored);
            const [, , written, , contentType] =
                etag.putObjectIfMatch.mock.calls[0];
            expect(contentType).toBe('application/octet-stream');
            expect(decryptTextAsset(written as Buffer, keyFromHex(KEY))).toBe(
                RENAMED
            );
        });

        it('keeps a plaintext master plaintext even when a key is held', async () => {
            etag = makeEtag(MASTER);
            service = new HlsEditService(etag as never);
            await service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT], KEY);
            expect(etag.putObjectIfMatch.mock.calls[0][2]).toBe(RENAMED);
        });

        it('refuses, writing nothing, once the master has changed since it was read', async () => {
            etag = makeEtag(MASTER);
            service = new HlsEditService(etag as never);
            await expect(
                service.saveAudioTracks(s3, MASTER_KEY, 'v0', [EDIT])
            ).rejects.toThrow(ConflictException);
            expect(etag.putObjectIfAbsent).not.toHaveBeenCalled();
            expect(etag.putObjectIfMatch).not.toHaveBeenCalled();
        });

        it('refuses, writing nothing, an invalid edit', async () => {
            etag = makeEtag(MASTER);
            service = new HlsEditService(etag as never);
            const bad = {
                ...EDIT,
                to: { language: 'French', name: 'Français' },
            };
            await expect(
                service.saveAudioTracks(s3, MASTER_KEY, 'v1', [bad])
            ).rejects.toThrow(BadRequestException);
            expect(etag.putObjectIfAbsent).not.toHaveBeenCalled();
            expect(etag.putObjectIfMatch).not.toHaveBeenCalled();
        });
    });

    beforeEach(() => vi.clearAllMocks());
});
