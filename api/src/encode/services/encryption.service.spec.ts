import { EncryptionService } from './encryption.service.js';
import {
    mkdtempSync,
    mkdirSync,
    rmSync,
    writeFileSync,
    readFileSync,
    existsSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDecipheriv } from 'crypto';

describe('EncryptionService', () => {
    let service: EncryptionService;
    const originalSeed = process.env.HLS_ENCRYPTION_SEED;

    beforeEach(() => {
        service = new EncryptionService();
        process.env.HLS_ENCRYPTION_SEED = 'test-seed-value';
    });

    afterEach(() => {
        if (originalSeed !== undefined) {
            process.env.HLS_ENCRYPTION_SEED = originalSeed;
        } else {
            delete process.env.HLS_ENCRYPTION_SEED;
        }
    });

    describe('deriveKey', () => {
        it('should generate a 16-byte key', () => {
            const key = service.deriveKey('session-1');
            expect(key).toBeInstanceOf(Buffer);
            expect(key.length).toBe(16);
        });

        it('should produce deterministic keys for the same session and seed', () => {
            const key1 = service.deriveKey('session-1');
            const key2 = service.deriveKey('session-1');
            expect(key1).toEqual(key2);
        });

        it('should produce different keys for different session IDs', () => {
            const key1 = service.deriveKey('session-1');
            const key2 = service.deriveKey('session-2');
            expect(key1).not.toEqual(key2);
        });

        it('should throw when HLS_ENCRYPTION_SEED is not set', () => {
            delete process.env.HLS_ENCRYPTION_SEED;
            expect(() => service.deriveKey('session-1')).toThrow(
                'HLS_ENCRYPTION_SEED environment variable is required',
            );
        });
    });

    describe('generateIV', () => {
        it('should generate a 16-byte IV', () => {
            const iv = service.generateIV();
            expect(iv).toBeInstanceOf(Buffer);
            expect(iv.length).toBe(16);
        });

        it('should produce different IVs on successive calls', () => {
            const iv1 = service.generateIV();
            const iv2 = service.generateIV();
            expect(iv1).not.toEqual(iv2);
        });
    });

    describe('encryptSegment', () => {
        it('should produce valid AES-128-CBC ciphertext', () => {
            const key = service.deriveKey('session-1');
            const iv = Buffer.alloc(16, 0x01);
            const plaintext = Buffer.from('Hello, HLS encryption!');

            const ciphertext = service.encryptSegment(plaintext, key, iv);

            expect(ciphertext).toBeInstanceOf(Buffer);
            expect(ciphertext.length).toBeGreaterThan(0);
            expect(ciphertext.length % 16).toBe(0);
            expect(ciphertext).not.toEqual(plaintext);
        });

        it('should be decryptable with the same key and IV', () => {
            const key = service.deriveKey('session-1');
            const iv = Buffer.alloc(16, 0x02);
            const plaintext = Buffer.from('Roundtrip test data for AES-128-CBC');

            const ciphertext = service.encryptSegment(plaintext, key, iv);

            const decipher = createDecipheriv('aes-128-cbc', key, iv);
            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);
            expect(decrypted).toEqual(plaintext);
        });

        it('should apply PKCS7 padding (output >= input, multiple of 16)', () => {
            const key = service.deriveKey('session-1');
            const iv = Buffer.alloc(16, 0x03);

            for (const len of [1, 15, 16, 17, 31, 32, 100]) {
                const plaintext = Buffer.alloc(len, 0xaa);
                const ciphertext = service.encryptSegment(plaintext, key, iv);
                expect(ciphertext.length).toBeGreaterThanOrEqual(len);
                expect(ciphertext.length % 16).toBe(0);
            }
        });
    });

    describe('encryptHlsOutput', () => {
        let tmpDir: string;

        beforeEach(() => {
            tmpDir = mkdtempSync(join(tmpdir(), 'encryption-service-'));
        });

        afterEach(() => {
            rmSync(tmpDir, { recursive: true, force: true });
        });

        function createHlsOutput() {
            const stream0 = join(tmpDir, 'stream_0');
            const stream1 = join(tmpDir, 'stream_1');
            mkdirSync(stream0);
            mkdirSync(stream1);

            writeFileSync(join(stream0, 'init.mp4'), Buffer.from('ftyp+moov'));
            writeFileSync(join(stream0, 'segment_00000.m4s'), Buffer.from('video-segment-0'));
            writeFileSync(join(stream0, 'segment_00001.m4s'), Buffer.from('video-segment-1'));

            writeFileSync(join(stream1, 'init.mp4'), Buffer.from('ftyp+moov-audio'));
            writeFileSync(join(stream1, 'segment_00000.m4s'), Buffer.from('audio-segment-0'));

            writeFileSync(
                join(stream0, 'playlist.m3u8'),
                [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-TARGETDURATION:6',
                    '#EXT-X-PLAYLIST-TYPE:VOD',
                    '#EXT-X-MAP:URI="init.mp4"',
                    '#EXTINF:6.000,',
                    'segment_00000.m4s',
                    '#EXTINF:6.000,',
                    'segment_00001.m4s',
                    '#EXT-X-ENDLIST',
                ].join('\n'),
                'utf-8',
            );

            writeFileSync(
                join(stream1, 'playlist.m3u8'),
                [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-TARGETDURATION:6',
                    '#EXT-X-PLAYLIST-TYPE:VOD',
                    '#EXT-X-MAP:URI="init.mp4"',
                    '#EXTINF:6.000,',
                    'segment_00000.m4s',
                    '#EXT-X-ENDLIST',
                ].join('\n'),
                'utf-8',
            );

            writeFileSync(
                join(tmpDir, 'master.m3u8'),
                [
                    '#EXTM3U',
                    '#EXT-X-VERSION:7',
                    '#EXT-X-STREAM-INF:BANDWIDTH=3000000',
                    'stream_0/playlist.m3u8',
                ].join('\n'),
                'utf-8',
            );
        }

        it('should return a 16-byte key and 16-byte IV', async () => {
            createHlsOutput();
            const result = await service.encryptHlsOutput(
                tmpDir,
                'session-1',
                'https://example.com/key',
            );
            expect(result.key).toBeInstanceOf(Buffer);
            expect(result.key.length).toBe(16);
            expect(result.iv).toBeInstanceOf(Buffer);
            expect(result.iv.length).toBe(16);
        });

        it('should encrypt .m4s segment files', async () => {
            createHlsOutput();
            const originalSegment = readFileSync(
                join(tmpDir, 'stream_0', 'segment_00000.m4s'),
            );

            await service.encryptHlsOutput(tmpDir, 'session-1', 'https://example.com/key');

            const encryptedSegment = readFileSync(
                join(tmpDir, 'stream_0', 'segment_00000.m4s'),
            );
            expect(encryptedSegment).not.toEqual(originalSegment);
            expect(encryptedSegment.length % 16).toBe(0);
        });

        it('should NOT encrypt init.mp4 files', async () => {
            createHlsOutput();
            const originalInit = readFileSync(
                join(tmpDir, 'stream_0', 'init.mp4'),
            );

            await service.encryptHlsOutput(tmpDir, 'session-1', 'https://example.com/key');

            const afterInit = readFileSync(
                join(tmpDir, 'stream_0', 'init.mp4'),
            );
            expect(afterInit).toEqual(originalInit);
        });

        it('should produce decryptable segments', async () => {
            createHlsOutput();
            const plaintext = readFileSync(
                join(tmpDir, 'stream_0', 'segment_00000.m4s'),
            );

            const { key, iv } = await service.encryptHlsOutput(
                tmpDir,
                'session-1',
                'https://example.com/key',
            );

            const ciphertext = readFileSync(
                join(tmpDir, 'stream_0', 'segment_00000.m4s'),
            );
            const decipher = createDecipheriv('aes-128-cbc', key, iv);
            const decrypted = Buffer.concat([
                decipher.update(ciphertext),
                decipher.final(),
            ]);
            expect(decrypted).toEqual(plaintext);
        });

        it('should inject #EXT-X-KEY tag into media playlists', async () => {
            createHlsOutput();
            const { iv } = await service.encryptHlsOutput(
                tmpDir,
                'session-1',
                'https://example.com/key',
            );

            const playlist = readFileSync(
                join(tmpDir, 'stream_0', 'playlist.m3u8'),
                'utf-8',
            );
            const expectedTag = `#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key",IV=0x${iv.toString('hex')}`;
            expect(playlist).toContain(expectedTag);
        });

        it('should place #EXT-X-KEY tag before the first #EXTINF', async () => {
            createHlsOutput();
            await service.encryptHlsOutput(tmpDir, 'session-1', 'https://example.com/key');

            const playlist = readFileSync(
                join(tmpDir, 'stream_0', 'playlist.m3u8'),
                'utf-8',
            );
            const lines = playlist.split('\n');
            const keyIdx = lines.findIndex(l => l.startsWith('#EXT-X-KEY:'));
            const firstExtinfIdx = lines.findIndex(l => l.startsWith('#EXTINF:'));
            expect(keyIdx).toBeGreaterThan(-1);
            expect(firstExtinfIdx).toBeGreaterThan(-1);
            expect(keyIdx).toBeLessThan(firstExtinfIdx);
        });

        it('should NOT inject #EXT-X-KEY into master playlists (no #EXTINF)', async () => {
            createHlsOutput();
            await service.encryptHlsOutput(tmpDir, 'session-1', 'https://example.com/key');

            const master = readFileSync(
                join(tmpDir, 'master.m3u8'),
                'utf-8',
            );
            expect(master).not.toContain('#EXT-X-KEY:');
        });

        it('should inject #EXT-X-KEY into all media playlists across streams', async () => {
            createHlsOutput();
            await service.encryptHlsOutput(tmpDir, 'session-1', 'https://example.com/key');

            const pl0 = readFileSync(join(tmpDir, 'stream_0', 'playlist.m3u8'), 'utf-8');
            const pl1 = readFileSync(join(tmpDir, 'stream_1', 'playlist.m3u8'), 'utf-8');
            expect(pl0).toContain('#EXT-X-KEY:METHOD=AES-128');
            expect(pl1).toContain('#EXT-X-KEY:METHOD=AES-128');
        });

        it('should encrypt segments across all stream directories', async () => {
            createHlsOutput();
            const origVideo = readFileSync(join(tmpDir, 'stream_0', 'segment_00000.m4s'));
            const origAudio = readFileSync(join(tmpDir, 'stream_1', 'segment_00000.m4s'));

            await service.encryptHlsOutput(tmpDir, 'session-1', 'https://example.com/key');

            expect(readFileSync(join(tmpDir, 'stream_0', 'segment_00000.m4s'))).not.toEqual(origVideo);
            expect(readFileSync(join(tmpDir, 'stream_1', 'segment_00000.m4s'))).not.toEqual(origAudio);
        });

        it('should handle output with no stream directories gracefully', async () => {
            mkdirSync(tmpDir, { recursive: true });
            writeFileSync(join(tmpDir, 'master.m3u8'), '#EXTM3U\n', 'utf-8');

            const result = await service.encryptHlsOutput(
                tmpDir,
                'session-1',
                'https://example.com/key',
            );
            expect(result.key.length).toBe(16);
            expect(result.iv.length).toBe(16);
        });
    });
});
