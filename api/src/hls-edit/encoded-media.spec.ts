import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { HlsEditService } from './hls-edit.service.js';
import {
    IMMUTABLE_CACHE_CONTROL,
    MasterRevisionService,
} from './master-revision.service.js';
import {
    decryptTextAsset,
    encryptTextAsset,
    keyFromHex,
} from '../encode/services/lmcenc.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';
import { listThumbnailEntries } from '@luminary-media-converter/hls-core';

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
const ANGLES_MASTER = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Francais",LANGUAGE="fr",DEFAULT=YES,URI="a/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="main",NAME="Main",DEFAULT=YES',
    '#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="side",NAME="Side",DEFAULT=NO',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,VIDEO="main",AUDIO="aud"',
    'stream_main/playlist.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,VIDEO="side",AUDIO="aud"',
    'stream_side/playlist.m3u8',
    '',
].join('\n');
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
const NEXT_KEY = 'posts/p1/s1/master_r1.m3u8';

function makeEtag(stored: Buffer | string, listed: string[] = []) {
    return {
        getObjectWithEtag: vi.fn().mockResolvedValue({
            body: Buffer.from(stored as never),
            etag: 'v1',
        }),
        putObjectIfMatch: vi.fn(),
        putObjectIfAbsent: vi.fn().mockResolvedValue('v2'),
        objectExists: vi.fn().mockResolvedValue(false),
        putObject: vi.fn(),
        createClient: vi.fn(() => ({
            send: vi.fn().mockResolvedValue({
                Contents: listed.map((Key) => ({ Key })),
            }),
        })),
    };
}

function makeService(etag: ReturnType<typeof makeEtag>): HlsEditService {
    return new HlsEditService(
        etag as never,
        new MasterRevisionService(etag as never)
    );
}

/** The one write a save makes: its master as the revision after the one read. */
function revisionWrite(etag: ReturnType<typeof makeEtag>) {
    expect(etag.putObjectIfAbsent).toHaveBeenCalledTimes(1);
    // The revision read is never written again.
    expect(etag.putObjectIfMatch).not.toHaveBeenCalled();
    expect(etag.putObject).not.toHaveBeenCalled();
    const [, key, body, contentType, opts] =
        etag.putObjectIfAbsent.mock.calls[0];
    return { key, body, contentType, opts };
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
            service = makeService(etag);
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
                angles: [],
                subtitles: [],
                chapterLanguages: ['en', 'fr'],
                etag: 'v1',
                encrypted: false,
                masterKey: MASTER_KEY,
            });
        });

        it('lists the camera angles', async () => {
            etag = makeEtag(ANGLES_MASTER, [MASTER_KEY]);
            service = makeService(etag);
            const media = await service.readEncodedMedia(s3, MASTER_KEY);
            expect(media.angles).toEqual([
                { id: 'main', name: 'Main', default: true, renditions: 1 },
                { id: 'side', name: 'Side', default: false, renditions: 1 },
            ]);
        });

        it('names the scrub thumbnails beside the master', async () => {
            etag = makeEtag(MASTER, [
                MASTER_KEY,
                'posts/p1/s1/thumbnails/thumbnails.vtt',
            ]);
            service = makeService(etag);
            const media = await service.readEncodedMedia(s3, MASTER_KEY);
            expect(media.thumbnailsVtt).toBe('thumbnails/thumbnails.vtt');
        });

        it('decrypts an encrypted master with the key, and says it is encrypted', async () => {
            etag = makeEtag(encryptTextAsset(MASTER, keyFromHex(KEY)));
            service = makeService(etag);
            const media = await service.readEncodedMedia(s3, MASTER_KEY, KEY);
            expect(media.encrypted).toBe(true);
            expect(media.tracks[0].name).toBe('Francais');
        });

        it('refuses an encrypted master without its key', async () => {
            etag = makeEtag(encryptTextAsset(MASTER, keyFromHex(KEY)));
            service = makeService(etag);
            await expect(
                service.readEncodedMedia(s3, MASTER_KEY)
            ).rejects.toThrow(BadRequestException);
        });
    });

    describe('saveAudioTracks', () => {
        it('writes the renamed master in plaintext as the next revision, leaving the one read as it was, cached for good', async () => {
            etag = makeEtag(MASTER);
            service = makeService(etag);
            const media = await service.saveAudioTracks(s3, MASTER_KEY, 'v1', [
                EDIT,
            ]);

            expect(revisionWrite(etag)).toEqual({
                key: NEXT_KEY,
                body: RENAMED,
                contentType: 'application/vnd.apple.mpegurl',
                opts: { cacheControl: IMMUTABLE_CACHE_CONTROL },
            });
            // Read back from the revision it wrote.
            expect(media.masterKey).toBe(NEXT_KEY);
            expect(etag.getObjectWithEtag).toHaveBeenLastCalledWith(
                s3,
                NEXT_KEY
            );
        });

        it('writes an encrypted master back encrypted with the same key', async () => {
            const stored = encryptTextAsset(MASTER, keyFromHex(KEY));
            etag = makeEtag(stored);
            service = makeService(etag);
            await service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT], KEY);

            const { key, body, contentType } = revisionWrite(etag);
            expect(key).toBe(NEXT_KEY);
            expect(contentType).toBe('application/octet-stream');
            expect(decryptTextAsset(body as Buffer, keyFromHex(KEY))).toBe(
                RENAMED
            );
        });

        it('keeps a plaintext master plaintext even when a key is held', async () => {
            etag = makeEtag(MASTER);
            service = makeService(etag);
            await service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT], KEY);
            expect(revisionWrite(etag).body).toBe(RENAMED);
        });

        it('refuses, writing nothing, once the master has changed since it was read', async () => {
            etag = makeEtag(MASTER);
            service = makeService(etag);
            await expect(
                service.saveAudioTracks(s3, MASTER_KEY, 'v0', [EDIT])
            ).rejects.toThrow(ConflictException);
            expect(etag.putObjectIfAbsent).not.toHaveBeenCalled();
            expect(etag.putObject).not.toHaveBeenCalled();
        });

        it('refuses, writing nothing, an invalid edit', async () => {
            etag = makeEtag(MASTER);
            service = makeService(etag);
            const bad = {
                ...EDIT,
                to: { language: 'French', name: 'Français' },
            };
            await expect(
                service.saveAudioTracks(s3, MASTER_KEY, 'v1', [bad])
            ).rejects.toThrow(BadRequestException);
            expect(etag.putObjectIfAbsent).not.toHaveBeenCalled();
            expect(etag.putObject).not.toHaveBeenCalled();
        });

        it('refuses, as changed elsewhere, when another save already wrote the next revision', async () => {
            etag = makeEtag(MASTER);
            etag.objectExists.mockResolvedValue(true);
            service = makeService(etag);
            await expect(
                service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT])
            ).rejects.toMatchObject({
                response: { code: 'CHANGED_ELSEWHERE' },
            });
            expect(etag.putObjectIfAbsent).not.toHaveBeenCalled();
        });

        it('refuses, as changed elsewhere, when the conditional write finds the next revision there', async () => {
            etag = makeEtag(MASTER);
            etag.putObjectIfAbsent.mockResolvedValue(undefined);
            service = makeService(etag);
            await expect(
                service.saveAudioTracks(s3, MASTER_KEY, 'v1', [EDIT])
            ).rejects.toMatchObject({
                response: { code: 'CHANGED_ELSEWHERE' },
            });
        });
    });

    beforeEach(() => vi.clearAllMocks());

    describe('saveVideoAngles', () => {
        it('renames in the next revision, from the version read, and goes back encrypted', async () => {
            const stored = encryptTextAsset(ANGLES_MASTER, keyFromHex(KEY));
            etag = makeEtag(stored, [MASTER_KEY]);
            service = makeService(etag);
            await service.saveVideoAngles(
                s3,
                MASTER_KEY,
                'v1',
                [{ id: 'side', name: 'Pulpit' }],
                KEY
            );
            const { key, body, contentType, opts } = revisionWrite(etag);
            expect(key).toBe(NEXT_KEY);
            expect(contentType).toBe('application/octet-stream');
            expect(opts).toEqual({ cacheControl: IMMUTABLE_CACHE_CONTROL });
            expect(decryptTextAsset(body as Buffer, keyFromHex(KEY))).toBe(
                ANGLES_MASTER.replace('NAME="Side"', 'NAME="Pulpit"')
            );
        });

        it('refuses a master changed since it was read', async () => {
            etag = makeEtag(ANGLES_MASTER, [MASTER_KEY]);
            service = makeService(etag);
            await expect(
                service.saveVideoAngles(s3, MASTER_KEY, 'v0', [], undefined, [
                    'side',
                ])
            ).rejects.toThrow(ConflictException);
            expect(etag.putObjectIfAbsent).not.toHaveBeenCalled();
        });

        const strip = (angle: string, uri: string) =>
            `#EXT-X-SESSION-DATA:DATA-ID="com.luminary.thumbnails.${angle}",VIDEO="${angle}",URI="${uri}",FORMAT=RAW`;
        const withStrips = (...lines: string[]) =>
            ANGLES_MASTER.replace(
                '#EXTM3U\n',
                `#EXTM3U\n${lines.join('\n')}\n`
            );
        const stripsAfterRemovingSide = async (master: string) => {
            etag = makeEtag(master, [MASTER_KEY]);
            service = makeService(etag);
            await service.saveVideoAngles(s3, MASTER_KEY, 'v1', [], undefined, [
                'side',
            ]);
            const { body } = revisionWrite(etag);
            return listThumbnailEntries(String(body)).map((e) => ({
                video: e.video,
                uri: e.uri,
            }));
        };

        it("keeps the video's only strip, for every angle, when the angle it was sampled from goes", async () => {
            expect(
                await stripsAfterRemovingSide(
                    withStrips(strip('side', 'thumbnails/thumbnails_9f8e.vtt'))
                )
            ).toEqual([
                { video: undefined, uri: 'thumbnails/thumbnails_9f8e.vtt' },
            ]);
        });

        it("drops a removed angle's strip when another strip remains", async () => {
            expect(
                await stripsAfterRemovingSide(
                    withStrips(
                        strip('main', 'thumbnails/main.vtt'),
                        strip('side', 'thumbnails/side.vtt')
                    )
                )
            ).toEqual([{ video: 'main', uri: 'thumbnails/main.vtt' }]);
        });
    });
});
