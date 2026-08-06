import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDecipheriv } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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
            Array.from({ length: 50 }, () => service.generateKey().toString('hex')),
        );

        expect(keys.size).toBe(50);
    });

    it('never repeats an IV', () => {
        const ivs = new Set(
            Array.from({ length: 50 }, () => service.generateIV().toString('hex')),
        );

        expect(ivs.size).toBe(50);
    });
});

describe('EncryptionService — encrypting a segment', () => {
    it('rewrites the file in place, and it decrypts back to the original', async () => {
        const plain = Buffer.from('a fake mpeg-ts segment, but a real round trip');
        const path = join(dir, 'media_0.ts');
        writeFileSync(path, plain);

        const key = service.generateKey();
        const iv = service.generateIV();
        await service.encryptSegment(path, key, iv);

        const onDisk = readFileSync(path);
        expect(onDisk.equals(plain)).toBe(false);

        const decipher = createDecipheriv('aes-128-cbc', key, iv);
        const round = Buffer.concat([decipher.update(onDisk), decipher.final()]);
        expect(round.equals(plain)).toBe(true);
    });

    it('leaves no temporary file behind', async () => {
        const path = join(dir, 'media_0.ts');
        writeFileSync(path, 'x');

        await service.encryptSegment(path, service.generateKey(), service.generateIV());

        expect(() => readFileSync(`${path}.enc.tmp`)).toThrow();
    });

    it('cleans up its temporary file when encryption fails', async () => {
        // Otherwise a failed encode leaves .enc.tmp files beside the segments,
        // and the next pass has to tell them apart from real output.
        const path = join(dir, 'media_0.ts');
        writeFileSync(path, 'x');

        await expect(
            service.encryptSegment(path, Buffer.alloc(3), service.generateIV()),
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
            '#EXT-X-KEY:METHOD=AES-128,URI="luminary://key",IV=0x000102030405060708090a0b0c0d0e0f',
        );
    });

    it('reaches playlists nested under the output directory', async () => {
        const a = write('stream_720p/playlist.m3u8', MEDIA);
        const b = write('stream_1080p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(dir, 'luminary://key', Buffer.alloc(16));

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

        await service.injectKeyTagsIntoPlaylists(dir, 'luminary://key', Buffer.alloc(16));

        expect(readFileSync(path, 'utf-8')).not.toContain('#EXT-X-KEY:');
    });

    it('inserts exactly one tag, however many segments there are', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(dir, 'luminary://key', Buffer.alloc(16));

        const count = readFileSync(path, 'utf-8')
            .split('\n')
            .filter((l) => l.startsWith('#EXT-X-KEY:')).length;
        expect(count).toBe(1);
    });

    it('keeps every original line', async () => {
        const path = write('stream_720p/playlist.m3u8', MEDIA);

        await service.injectKeyTagsIntoPlaylists(dir, 'luminary://key', Buffer.alloc(16));

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
            Buffer.alloc(16),
        );

        expect(readFileSync(path, 'utf-8')).toContain(
            'URI="https://keys.example.com/s1.key"',
        );
    });
});
