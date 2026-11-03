import { createCipheriv, randomBytes } from 'crypto';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { HlsVariant } from '@luminary-media-converter/hls-core';
import {
    ExistingThumbnailsService,
    decryptSegment,
    ivFor,
    pickVariant,
} from './existing-thumbnails.service.js';
import { decryptTextAsset, encryptTextAsset } from './lmcenc.js';

const variant = (
    uri: string,
    width: number,
    height: number,
    videoGroup?: string
) =>
    ({
        uri,
        bandwidth: width * 1000,
        resolutionParsed: { width, height },
        videoGroup,
    }) as unknown as HlsVariant;

/** As the encoder encrypts a segment: whole-file AES-128-CBC. */
const encrypt = (body: Buffer, key: Buffer, iv: Buffer) => {
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([cipher.update(body), cipher.final()]);
};

async function until(condition: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
        if (condition()) return;
        await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`Timed out waiting for ${what}`);
}

describe('pickVariant', () => {
    it('takes the smallest rendition still as wide as a frame', () => {
        const picked = pickVariant([
            variant('a.m3u8', 1280, 720),
            variant('b.m3u8', 426, 240),
            variant('c.m3u8', 256, 144),
            variant('d.m3u8', 128, 72),
        ]);
        expect(picked?.uri).toBe('c.m3u8');
    });

    it('takes the widest when every rendition is narrower than a frame', () => {
        const picked = pickVariant([
            variant('a.m3u8', 96, 54),
            variant('b.m3u8', 128, 72),
        ]);
        expect(picked?.uri).toBe('b.m3u8');
    });

    it('stays on the first angle', () => {
        const picked = pickVariant([
            variant('main_720.m3u8', 1280, 720, 'main'),
            variant('main_360.m3u8', 640, 360, 'main'),
            variant('side_144.m3u8', 256, 144, 'side'),
        ]);
        expect(picked?.uri).toBe('main_360.m3u8');
    });
});

describe('segment decryption', () => {
    it("uses the key tag's IV when it has one", () => {
        expect(
            ivFor('0x000102030405060708090a0b0c0d0e0f', 7).toString('hex')
        ).toBe('000102030405060708090a0b0c0d0e0f');
    });

    it('falls back to the sequence number, as HLS says', () => {
        expect(ivFor(undefined, 5).toString('hex')).toBe(
            '00000000000000000000000000000005'
        );
    });

    it('undoes the encryption the encoder applies', () => {
        const key = randomBytes(16);
        const iv = randomBytes(16);
        const body = Buffer.from('a media segment');
        expect(decryptSegment(encrypt(body, key, iv), key, iv)).toEqual(body);
    });
});

describe('ExistingThumbnailsService', () => {
    const key = randomBytes(16);
    const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
    const s3 = {
        endPoint: 'e',
        bucket: 'b',
        accessKey: 'a',
        secretKey: 's',
    } as any;
    let workDir: string;
    let objects: Map<string, Buffer>;
    let s3Etag: any;
    let thumbnails: any;
    let sessions: any;
    let videoBytes: Buffer | null;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'existing-thumbs-'));
        process.env.WORK_DIR = workDir;
        videoBytes = null;
        const master = [
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720',
            'stream_720p/playlist.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=256x144',
            'stream_144p/playlist.m3u8',
        ].join('\n');
        const playlist = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MAP:URI="../media/v0_0.m4s",BYTERANGE="4@0"',
            '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x000102030405060708090a0b0c0d0e0f',
            '#EXTINF:6.0,',
            '#EXT-X-BYTERANGE:16@4',
            '../media/v0_0.m4s',
            '#EXTINF:4.0,',
            '#EXT-X-BYTERANGE:16@20',
            '../media/v0_0.m4s',
            '#EXT-X-ENDLIST',
        ].join('\n');
        const seg1 = encrypt(Buffer.from('one'), key, iv);
        const seg2 = encrypt(Buffer.from('two'), key, iv);
        objects = new Map<string, Buffer>([
            ['posts/s1/master.m3u8', encryptTextAsset(master, key)],
            [
                'posts/s1/stream_144p/playlist.m3u8',
                encryptTextAsset(playlist, key),
            ],
            [
                'posts/s1/media/v0_0.m4s',
                Buffer.concat([Buffer.from('INIT'), seg1, seg2]),
            ],
        ]);
        s3Etag = {
            getObjectWithEtag: vi.fn(async (_c: unknown, k: string) => ({
                body: objects.get(k)!,
                etag: 'e',
            })),
            getObjectRange: vi.fn(
                async (
                    _c: unknown,
                    k: string,
                    offset: number,
                    length: number
                ) => objects.get(k)!.subarray(offset, offset + length)
            ),
            putObject: vi.fn(async () => ({ etag: 'e' })),
            listKeys: vi.fn(async () => [
                'posts/s1/thumbnails/thumbnails.vtt',
                'posts/s1/thumbnails/sprite_001.webp',
                'posts/s1/thumbnails/sprite_002.webp',
            ]),
            deleteObjects: vi.fn(async () => undefined),
        };
        thumbnails = {
            removePreview: vi.fn(async () => undefined),
            packForDelivery: vi.fn(
                async (opts: { inputPath: string; outputDir: string }) => {
                    videoBytes = readFileSync(opts.inputPath);
                    const dir = join(opts.outputDir, 'thumbnails');
                    mkdirSync(dir, { recursive: true });
                    writeFileSync(join(dir, 'sprite_001.webp'), 'image');
                    writeFileSync(
                        join(dir, 'thumbnails.vtt'),
                        'WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nsprite_001.webp#xywh=0,0,160,90\n'
                    );
                    return { vttRelativePath: 'thumbnails/thumbnails.vtt' };
                }
            ),
        };
        sessions = { setThumbnailsVtt: vi.fn() };
    });

    afterEach(() => {
        delete process.env.WORK_DIR;
        rmSync(workDir, { recursive: true, force: true });
    });

    const start = (svc: ExistingThumbnailsService) =>
        svc.start('s1', {
            s3,
            masterKey: 'posts/s1/master.m3u8',
            keyHex: key.toString('hex'),
        });

    it("makes the storyboard again from the video's smallest rendition, and replaces it", async () => {
        const svc = new ExistingThumbnailsService(sessions, s3Etag, thumbnails);

        start(svc);
        await until(() => svc.job('s1')?.state !== 'running', 'the job to end');

        expect(svc.job('s1')).toEqual({ state: 'done' });
        // Init, then each segment decrypted, in order.
        expect(videoBytes?.toString()).toBe('INITonetwo');
        expect(thumbnails.packForDelivery).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId: 's1',
                sourceDuration: 10,
                videoTracks: [{ index: 0, width: 256, height: 144 }],
            })
        );

        const puts = s3Etag.putObject.mock.calls.map(
            (c: any[]) => c[1] as string
        );
        const sprite = puts.find((k: string) =>
            /sprite_[^/]+_001\.webp$/.test(k)
        )!;
        expect(sprite).toMatch(/^posts\/s1\/thumbnails\/sprite_\w+_001\.webp$/);

        const vttCall = s3Etag.putObject.mock.calls.find(
            (c: any[]) => c[1] === 'posts/s1/thumbnails/thumbnails.vtt'
        )!;
        // Encrypted like the playlists beside it, and naming the new sprite.
        const vtt = decryptTextAsset(vttCall[2], key);
        expect(vtt).toContain(`${sprite.split('/').pop()}#xywh=0,0,160,90`);
        expect(vttCall[4]).toEqual({ cacheControl: 'no-cache' });

        expect(s3Etag.deleteObjects).toHaveBeenCalledWith(s3, [
            'posts/s1/thumbnails/sprite_001.webp',
            'posts/s1/thumbnails/sprite_002.webp',
        ]);
        expect(sessions.setThumbnailsVtt).toHaveBeenCalledWith(
            's1',
            'thumbnails/thumbnails.vtt'
        );
    });

    it('says why when no thumbnails could be made, and touches nothing', async () => {
        thumbnails.packForDelivery.mockResolvedValue(null);
        const svc = new ExistingThumbnailsService(sessions, s3Etag, thumbnails);

        start(svc);
        await until(() => svc.job('s1')?.state !== 'running', 'the job to end');

        expect(svc.job('s1')).toEqual({
            state: 'failed',
            error: 'No thumbnails could be made from this video',
        });
        expect(s3Etag.putObject).not.toHaveBeenCalled();
        expect(s3Etag.deleteObjects).not.toHaveBeenCalled();
    });

    it('runs one at a time per session', () => {
        const svc = new ExistingThumbnailsService(sessions, s3Etag, thumbnails);
        start(svc);
        expect(() => start(svc)).toThrow(/already being made again/);
    });
});
