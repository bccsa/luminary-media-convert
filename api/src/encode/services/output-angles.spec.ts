import { describe, expect, it } from 'vitest';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import { angleGroupIdForTrack, outputAngles } from './output-angles.js';

const rendition = (sourceTrackIndex: number, angle?: number) => ({
    width: 1280,
    height: 720,
    videoBitrateKbps: 2500,
    sourceTrackIndex,
    ...(angle === undefined ? {} : { angle }),
});

const config = (extra: Partial<EncodeConfigDto>): EncodeConfigDto =>
    ({ type: 'video', ...extra }) as EncodeConfigDto;

describe('outputAngles', () => {
    it('gives one picture no angles', () => {
        expect(
            outputAngles(
                config({ videoRenditions: [rendition(0), rendition(1, 0)] })
            )
        ).toEqual([]);
    });

    it('keeps two angles with the same name apart', () => {
        const angles = outputAngles(
            config({
                videoRenditions: [rendition(0), rendition(1)],
                videoTrackNames: [
                    { index: 0, name: 'Camera' },
                    { index: 1, name: 'Camera' },
                ],
            })
        );
        expect(angles.map((a) => a.groupId)).toEqual(['Camera', 'Camera_2']);
    });
});

describe('angleGroupIdForTrack', () => {
    it("labels a track with its rendition's angle, not its own index", () => {
        // Tracks 0 and 1 are one picture's ladder; track 2 is the second camera.
        const c = config({
            videoRenditions: [
                rendition(0, 0),
                rendition(1, 0),
                rendition(2, 2),
            ],
            videoTrackNames: [
                { index: 0, name: 'Main' },
                { index: 2, name: 'Side' },
            ],
        });
        expect(angleGroupIdForTrack(c, 1)).toBe('Main');
        expect(angleGroupIdForTrack(c, 2)).toBe('Side');
    });

    it('uses the angle recorded for a track no rendition was made from', () => {
        // A re-encoded angle has renditions from its best track only.
        const c = config({
            videoRenditions: [rendition(0, 0), rendition(2, 2)],
            videoTrackAngles: [
                { index: 0, angle: 0 },
                { index: 1, angle: 0 },
                { index: 2, angle: 2 },
            ],
        });
        expect(angleGroupIdForTrack(c, 1)).toBe('Angle_0');
    });

    it('gives the same group id the master does when names repeat', () => {
        const c = config({
            videoRenditions: [rendition(0), rendition(1)],
            videoTrackNames: [
                { index: 0, name: 'Camera' },
                { index: 1, name: 'Camera' },
            ],
        });
        expect(angleGroupIdForTrack(c, 1)).toBe('Camera_2');
    });

    it('is undefined for one picture, or a track in no angle', () => {
        expect(
            angleGroupIdForTrack(config({ videoRenditions: [rendition(0)] }), 0)
        ).toBeUndefined();
        expect(
            angleGroupIdForTrack(
                config({ videoRenditions: [rendition(0), rendition(1)] }),
                5
            )
        ).toBeUndefined();
    });
});
