import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecipheriv } from 'crypto';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { EncryptionService } from './encryption.service.js';

let dir: string;
let service: EncryptionService;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lmc-encrypt-'));
    service = new EncryptionService();
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('EncryptionService — key material', () => {
    it('produces a 16-byte AES-128 key and IV', () => {
        expect(service.generateKey()).toHaveLength(16);
        expect(service.generateIV()).toHaveLength(16);
    });

    it('never repeats a key', () => {
        // Nothing derives the key from a shared secret any more, so a leaked key
        // compromises exactly one session's output. A derived key would make
        // every past and future encode readable from one leak.
        const keys = new Set(
            Array.from({ length: 50 }, () =>
                service.generateKey().toString('hex')
            )
        );

        expect(keys.size).toBe(50);
    });

    it('never repeats an IV', () => {
        const ivs = new Set(
            Array.from({ length: 50 }, () =>
                service.generateIV().toString('hex')
            )
        );

        expect(ivs.size).toBe(50);
    });
});

describe('EncryptionService — encrypting a segment', () => {
    it('rewrites the file in place, and it decrypts back to the original', async () => {
        const plain = Buffer.from(
            'a fake mpeg-ts segment, but a real round trip'
        );
        const path = join(dir, 'media_0.ts');
        writeFileSync(path, plain);

        const key = service.generateKey();
        const iv = service.generateIV();
        await service.encryptSegment(path, key, iv);

        const onDisk = readFileSync(path);
        expect(onDisk.equals(plain)).toBe(false);

        const decipher = createDecipheriv('aes-128-cbc', key, iv);
        const round = Buffer.concat([
            decipher.update(onDisk),
            decipher.final(),
        ]);
        expect(round.equals(plain)).toBe(true);
    });

    it('leaves no temporary file behind', async () => {
        const path = join(dir, 'media_0.ts');
        writeFileSync(path, 'x');

        await service.encryptSegment(
            path,
            service.generateKey(),
            service.generateIV()
        );

        expect(() => readFileSync(`${path}.enc.tmp`)).toThrow();
    });

    it('cleans up its temporary file when encryption fails', async () => {
        // Otherwise a failed encode leaves .enc.tmp files beside the segments,
        // and the next pass has to tell them apart from real output.
        const path = join(dir, 'media_0.ts');
        writeFileSync(path, 'x');

        await expect(
            service.encryptSegment(path, Buffer.alloc(3), service.generateIV())
        ).rejects.toThrow();

        expect(() => readFileSync(`${path}.enc.tmp`)).toThrow();
    });
});

describe('EncryptionService — injecting key tags', () => {
    const MEDIA = [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-TARGETDURATION:6',
        '#EXTINF:6.000,',
        'media_0.ts',
        '#EXTINF:6.000,',
        'media_1.ts',
        '#EXT-X-ENDLIST',
    ].join('\n');

    function write(relPath: string, body: string): string {
        const full = join(dir, relPath);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, body);
        return full;
    }

    it('puts the key tag before the first segment', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);
        const iv = Buffer.alloc(16, 1);

        await service.injectKeyTagsIntoPlaylists(dir, 'luminary://key', iv);

        const lines = readFileSync(path, 'utf-8').split('\n');
        const keyLine = lines.findIndex((l) => l.startsWith('#EXT-X-KEY:'));
        const firstInf = lines.findIndex((l) => l.startsWith('#EXTINF:'));
        expect(keyLine).toBeGreaterThan(-1);
        expect(keyLine).toBeLessThan(firstInf);
    });

    it('writes the method, the URI it was given, and the IV as hex', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);
        const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

        await service.injectKeyTagsIntoPlaylists(dir, 'luminary://key', iv);

        expect(readFileSync(path, 'utf-8')).toContain(
            '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x000102030405060708090a0b0c0d0e0f'
        );
    });

    it('reaches playlists nested under the output directory', async () => {
        const a = write('stream_720p/playlist.m3u8', MEDIA);
        const b = write('stream_1080p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(
            dir,
            'luminary://key',
            Buffer.alloc(16)
        );

        expect(readFileSync(a, 'utf-8')).toContain('#EXT-X-KEY:');
        expect(readFileSync(b, 'utf-8')).toContain('#EXT-X-KEY:');
    });

    it('leaves the master playlist alone', async () => {
        // A master lists variants, not segments. A key tag there describes
        // nothing and players are entitled to reject it.
        const master = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=800000',
            'stream_720p/playlist.m3u8',
        ].join('\n');
        const path = write('master.m3u8', master);

        await service.injectKeyTagsIntoPlaylists(
            dir,
            'luminary://key',
            Buffer.alloc(16)
        );

        expect(readFileSync(path, 'utf-8')).not.toContain('#EXT-X-KEY:');
    });

    it('inserts exactly one tag, however many segments there are', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(
            dir,
            'luminary://key',
            Buffer.alloc(16)
        );

        const count = readFileSync(path, 'utf-8')
            .split('\n')
            .filter((l) => l.startsWith('#EXT-X-KEY:')).length;
        expect(count).toBe(1);
    });

    it('keeps every original line', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(
            dir,
            'luminary://key',
            Buffer.alloc(16)
        );

        const after = readFileSync(path, 'utf-8');
        for (const line of MEDIA.split('\n')) {
            expect(after).toContain(line);
        }
    });

    it('accepts an explicit key URL when one is configured', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(
            dir,
            'https://keys.example.com/s1.key',
            Buffer.alloc(16)
        );

        expect(readFileSync(path, 'utf-8')).toContain(
            'URI="https://keys.example.com/s1.key"'
        );
    });
});

describe('EncryptionService — encryptTextAssets (LMCENC01)', () => {
    let service: EncryptionService;
    let dir: string;

    const KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const MAGIC = 'LMCENC01';

    /** Independent decryptor: the format spec, not the implementation. */
    function decrypt(payload: Buffer, key: Buffer): string {
        expect(payload.subarray(0, 8).toString('ascii')).toBe(MAGIC);
        const iv = payload.subarray(8, 24);
        const decipher = createDecipheriv('aes-128-cbc', key, iv);
        return Buffer.concat([
            decipher.update(payload.subarray(24)),
            decipher.final(),
        ]).toString('utf-8');
    }

    beforeEach(() => {
        service = new EncryptionService();
        dir = mkdtempSync(join(tmpdir(), 'lmcenc-test-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('round-trips a playlist through the documented format', async () => {
        const plaintext = '#EXTM3U\n#EXT-X-VERSION:7\n';
        writeFileSync(join(dir, 'master.m3u8'), plaintext);

        const encrypted = await service.encryptTextAssets(dir, KEY);

        expect(encrypted).toEqual(['master.m3u8']);
        const onDisk = readFileSync(join(dir, 'master.m3u8'));
        expect(onDisk.subarray(0, 8).toString('ascii')).toBe(MAGIC);
        expect(decrypt(onDisk, KEY)).toBe(plaintext);
    });

    it('walks nested directories and takes both .m3u8 and .vtt', async () => {
        mkdirSync(join(dir, 'stream_0'));
        mkdirSync(join(dir, 'thumbnails'));
        writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n');
        writeFileSync(join(dir, 'stream_0', 'playlist.m3u8'), '#EXTM3U\nseg\n');
        writeFileSync(join(dir, 'thumbnails', 'thumbnails.vtt'), 'WEBVTT\n');
        // Not a text asset: stays exactly as it was.
        writeFileSync(join(dir, 'waveform.json'), '{"peaks":[]}');

        const encrypted = await service.encryptTextAssets(dir, KEY);

        expect(encrypted.sort()).toEqual([
            'master.m3u8',
            'stream_0/playlist.m3u8',
            'thumbnails/thumbnails.vtt',
        ]);
        expect(readFileSync(join(dir, 'waveform.json'), 'utf-8')).toBe(
            '{"peaks":[]}'
        );
        expect(
            decrypt(
                readFileSync(join(dir, 'thumbnails', 'thumbnails.vtt')),
                KEY
            )
        ).toBe('WEBVTT\n');
    });

    it('gives every file its own IV', async () => {
        // Identical plaintext, identical key: only a fresh IV per file keeps
        // the two ciphertexts apart, and reusing one across a whole output
        // would leak which playlists are the same.
        writeFileSync(join(dir, 'a.m3u8'), '#EXTM3U\n');
        writeFileSync(join(dir, 'b.m3u8'), '#EXTM3U\n');

        await service.encryptTextAssets(dir, KEY);

        const a = readFileSync(join(dir, 'a.m3u8'));
        const b = readFileSync(join(dir, 'b.m3u8'));
        expect(a.subarray(8, 24).equals(b.subarray(8, 24))).toBe(false);
        expect(a.equals(b)).toBe(false);
        expect(decrypt(a, KEY)).toBe('#EXTM3U\n');
        expect(decrypt(b, KEY)).toBe('#EXTM3U\n');
    });

    it('leaves an already-encrypted file alone', async () => {
        writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n');
        await service.encryptTextAssets(dir, KEY);
        const first = readFileSync(join(dir, 'master.m3u8'));

        const second = await service.encryptTextAssets(dir, KEY);

        expect(second).toEqual([]);
        expect(readFileSync(join(dir, 'master.m3u8')).equals(first)).toBe(true);
        // Still one layer deep — a double wrap would decrypt to ciphertext.
        expect(decrypt(first, KEY)).toBe('#EXTM3U\n');
    });

    it('refuses a key that is not AES-128', async () => {
        writeFileSync(join(dir, 'master.m3u8'), '#EXTM3U\n');

        await expect(
            service.encryptTextAssets(dir, Buffer.alloc(32))
        ).rejects.toThrow(/16-byte/);
    });
});
