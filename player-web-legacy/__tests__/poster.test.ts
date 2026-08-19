import { describe, it, expect } from 'vitest';
import { inflateSync } from 'node:zlib';
import { TRANSPARENT_POSTER } from '../src/vjs/poster';

/**
 * The poster is a base64 data URI, so its pixel is unreadable by eye and its
 * name is the only thing claiming to describe it. That claim was wrong once: the
 * bytes decoded to red at half opacity, and washed every frame the poster
 * covered — a YouTube iframe, and audio-only playback where the poster is the
 * only layer left.
 *
 * So this decodes the thing rather than reading its name.
 */
function decodePng(dataUri: string) {
    const base64 = dataUri.replace(/^data:image\/png;base64,/, '');
    const png = Buffer.from(base64, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    let offset = 8;
    let header: { width: number; height: number; colorType: number } | undefined;
    let scanlines: Buffer | undefined;

    while (offset < png.length) {
        const length = png.readUInt32BE(offset);
        const type = png.subarray(offset + 4, offset + 8).toString('ascii');
        const body = png.subarray(offset + 8, offset + 8 + length);

        if (type === 'IHDR') {
            header = {
                width: body.readUInt32BE(0),
                height: body.readUInt32BE(4),
                colorType: body.readUInt8(9),
            };
        }
        if (type === 'IDAT') scanlines = inflateSync(body);

        offset += 12 + length;
    }

    return { header, scanlines };
}

describe('TRANSPARENT_POSTER', () => {
    it('is a 1×1 RGBA PNG', () => {
        const { header } = decodePng(TRANSPARENT_POSTER);

        expect(header).toEqual({ width: 1, height: 1, colorType: 6 });
    });

    it('is actually transparent', () => {
        // The whole point: video.js runs its poster machinery and paints nothing.
        // A non-zero alpha here tints every frame the poster covers.
        const { scanlines } = decodePng(TRANSPARENT_POSTER);

        // Byte 0 is the row's filter type; the pixel follows.
        expect(Array.from(scanlines!.subarray(1, 5))).toEqual([0, 0, 0, 0]);
    });

    it('has a fully transparent alpha channel, stated on its own', () => {
        // Called out separately because alpha is the byte that matters and the
        // one that was wrong: 127 rather than 0.
        const { scanlines } = decodePng(TRANSPARENT_POSTER);

        expect(scanlines![4]).toBe(0);
    });
});
