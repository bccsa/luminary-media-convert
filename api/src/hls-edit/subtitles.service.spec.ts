import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { HlsEditService } from './hls-edit.service.js';
import {
    IMMUTABLE_CACHE_CONTROL,
    MasterRevisionService,
} from './master-revision.service.js';
import {
    encryptTextAsset,
    isLmcencPayload,
    keyFromHex,
    readMaybeEncrypted,
} from '../encode/services/lmcenc.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';

const KEY = '000102030405060708090a0b0c0d0e0f';
const s3: S3ConfigDto = { endPoint: 'r2.example.com', bucket: 'media', accessKey: 'k', secretKey: 's' };
const FOLDER = 'posts/p1/s1/';
const MASTER_KEY = `${FOLDER}master.m3u8`;
const R1 = `${FOLDER}master_r1.m3u8`;
const R2 = `${FOLDER}master_r2.m3u8`;

const MASTER = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
    'stream_720p/playlist.m3u8',
    '',
].join('\n');
const VARIANT = '#EXTM3U\n#EXTINF:6.0,\ns0.m4s\n#EXTINF:6.0,\ns1.m4s\n#EXTINF:2.5,\ns2.m4s\n#EXT-X-ENDLIST\n';
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nBonjour\n';

/** Storage in memory, with versions: a conditional write where something already is is refused, as S3 does. */
function storage(encrypted: boolean) {
    const key = keyFromHex(KEY);
    const wrap = (text: string) => (encrypted ? encryptTextAsset(text, key) : Buffer.from(text));
    const files = new Map<string, { body: Buffer; etag: string }>();
    let version = 0;
    const put = (k: string, body: Buffer | string) =>
        files.set(k, { body: Buffer.from(body as never), etag: `v${++version}` });
    put(MASTER_KEY, wrap(MASTER));
    put(`${FOLDER}stream_720p/playlist.m3u8`, wrap(VARIANT));

    const etag = {
        getObjectWithEtag: vi.fn(async (_c: unknown, k: string) => {
            const file = files.get(k);
            if (!file) throw Object.assign(new Error(`NoSuchKey ${k}`), { name: 'NoSuchKey' });
            return file;
        }),
        putObject: vi.fn(async (_c: unknown, k: string, body: Buffer | string) => void put(k, body)),
        putObjectIfAbsent: vi.fn(
            async (_c: unknown, k: string, body: Buffer | string) => {
                if (files.has(k)) return undefined;
                put(k, body);
                return files.get(k)!.etag;
            }
        ),
        objectExists: vi.fn(async (_c: unknown, k: string) => files.has(k)),
        deleteObjects: vi.fn(async (_c: unknown, keys: string[]) => keys.forEach((k) => files.delete(k))),
        createClient: vi.fn(() => ({
            send: vi.fn(async () => ({ Contents: [...files.keys()].map((Key) => ({ Key })) })),
        })),
    };
    const text = (k: string) => readMaybeEncrypted(files.get(k)!.body, key);
    const etagOf = () => files.get(MASTER_KEY)!.etag;
    const service = new HlsEditService(
        etag as never,
        new MasterRevisionService(etag as never)
    );
    return { etag, files, text, etagOf, service };
}

describe('HlsEditService — subtitles', () => {
    for (const encrypted of [true, false]) {
        const keyHex = encrypted ? KEY : undefined;

        it(`adds a language: its words and playlist under a fresh name, then the next master revision from the version read (${encrypted ? 'encrypted' : 'plain'})`, async () => {
            const store = storage(encrypted);
            const service = store.service;
            const media = await service.saveSubtitles(
                s3, MASTER_KEY, store.etagOf(), { language: 'fr', name: 'Français', vtt: VTT }, keyHex
            );

            expect(media.subtitles).toEqual([
                { language: 'fr', name: 'Français', uri: expect.stringMatching(/^subtitles\/fr_[0-9a-f]{8}\.m3u8$/), default: false },
            ]);
            const playlistKey = FOLDER + media.subtitles[0]!.uri;
            const vttKey = playlistKey.replace(/\.m3u8$/, '.vtt');
            expect(store.text(vttKey)).toBe(VTT);
            expect(store.text(playlistKey)).toContain('#EXTINF:14.500,');
            for (const k of [vttKey, playlistKey, R1]) {
                expect(isLmcencPayload(store.files.get(k)!.body), k).toBe(
                    encrypted
                );
            }
            // A new revision names the language; the one read stays as it was.
            expect(media.masterKey).toBe(R1);
            expect(store.text(R1)).toContain('SUBTITLES="subs"');
            expect(store.text(MASTER_KEY)).toBe(MASTER);
            // Every file the save wrote has a name of its own, so it may be cached for good.
            for (const [, k, , , opts] of store.etag.putObject.mock.calls) {
                expect(opts, k).toEqual({
                    cacheControl: IMMUTABLE_CACHE_CONTROL,
                });
            }
            expect(store.etag.putObjectIfAbsent).toHaveBeenCalledWith(
                s3,
                R1,
                expect.anything(),
                encrypted
                    ? 'application/octet-stream'
                    : 'application/vnd.apple.mpegurl',
                { cacheControl: IMMUTABLE_CACHE_CONTROL }
            );

            expect(await service.readSubtitles(s3, R1, 'fr', keyHex)).toEqual({
                language: 'fr', name: 'Français', vtt: VTT,
            });
        });
    }

    it('saves again under new names, and the files it replaced stay for the revision before', async () => {
        const store = storage(true);
        const service = store.service;
        const first = await service.saveSubtitles(s3, MASTER_KEY, store.etagOf(), { language: 'fr', name: 'Français', vtt: VTT }, KEY);
        const firstKey = FOLDER + first.subtitles[0]!.uri;

        const second = await service.saveSubtitles(
            s3,
            first.masterKey,
            first.etag,
            {
                language: 'fr',
                name: 'French',
                vtt: VTT.replace('Bonjour', 'Salut'),
            },
            KEY
        );
        expect(second.masterKey).toBe(R2);
        expect(second.subtitles.map((t) => t.name)).toEqual(['French']);
        expect(second.subtitles[0]!.uri).not.toBe(first.subtitles[0]!.uri);
        expect(store.files.has(firstKey)).toBe(true);
        expect(store.files.has(firstKey.replace(/\.m3u8$/, '.vtt'))).toBe(true);
        expect((await service.readSubtitles(s3, R2, 'fr', KEY)).vtt).toContain(
            'Salut'
        );
        // A viewer still on the revision before keeps its words.
        expect((await service.readSubtitles(s3, R1, 'fr', KEY)).vtt).toContain(
            'Bonjour'
        );
    });

    it('takes a language out of a new revision, and its files stay for the revision before', async () => {
        const store = storage(true);
        const service = store.service;
        const added = await service.saveSubtitles(s3, MASTER_KEY, store.etagOf(), { language: 'fr', name: 'Français', vtt: VTT }, KEY);
        const playlistKey = FOLDER + added.subtitles[0]!.uri;

        const removed = await service.removeSubtitles(
            s3,
            added.masterKey,
            added.etag,
            'fr',
            KEY
        );
        expect(removed.masterKey).toBe(R2);
        expect(removed.subtitles).toEqual([]);
        expect(store.text(R2)).toBe(MASTER);
        expect(store.files.has(playlistKey)).toBe(true);
        expect((await service.readSubtitles(s3, R1, 'fr', KEY)).vtt).toContain(
            'Bonjour'
        );
    });

    it('refuses to write a revision another save already wrote', async () => {
        const store = storage(true);
        store.files.set(R1, { body: Buffer.from('elsewhere'), etag: 'x' });
        await expect(
            store.service.saveSubtitles(
                s3,
                MASTER_KEY,
                store.etagOf(),
                { language: 'fr', name: 'Français', vtt: VTT },
                KEY
            )
        ).rejects.toMatchObject({
            response: { code: 'CHANGED_ELSEWHERE' },
        });
        expect(store.files.get(R1)!.body.toString()).toBe('elsewhere');
    });

    it('writes nothing over a version it did not read, or for words that are not WebVTT', async () => {
        const store = storage(true);
        const service = store.service;
        await expect(
            service.saveSubtitles(s3, MASTER_KEY, 'stale', { language: 'fr', name: 'Français', vtt: VTT }, KEY)
        ).rejects.toBeInstanceOf(ConflictException);
        await expect(
            service.saveSubtitles(s3, MASTER_KEY, store.etagOf(), { language: 'fr', name: 'Français', vtt: '1\n00:00:01,000 --> 00:00:02,000\nHi' }, KEY)
        ).rejects.toBeInstanceOf(BadRequestException);
        await expect(
            service.saveSubtitles(s3, MASTER_KEY, store.etagOf(), { language: 'French', name: 'Français', vtt: VTT }, KEY)
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(store.etag.putObject).not.toHaveBeenCalled();
        expect(store.etag.putObjectIfAbsent).not.toHaveBeenCalled();
    });
});
