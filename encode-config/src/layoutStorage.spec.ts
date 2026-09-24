import { describe, expect, it } from 'vitest';
import { beforeEach, vi } from 'vitest';
import {
    computeLayoutKey,
    getStoredConfig,
    getStoredContentPreset,
    saveConfig,
    saveContentPreset,
} from './layoutStorage';
import type { ProbeResult, VideoTrackInfo } from './types';

function video(overrides: Partial<VideoTrackInfo> = {}): VideoTrackInfo {
    return {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        bitrateKbps: 5000,
        frameRate: 25,
        ...overrides,
    };
}

function probe(videoTracks: VideoTrackInfo[]): ProbeResult {
    return {
        format: { duration: 120, bitrateKbps: 5000, formatName: 'mp4' },
        videoTracks,
        audioTracks: [
            {
                index: 0,
                codec: 'aac',
                bitrateKbps: 128,
                channels: 2,
                sampleRate: 48000,
            },
        ],
    };
}

/**
 * The fingerprint decides which saved track labels and languages come back for
 * a source. It is keyed on the media layout, so two sources that look the same
 * to it share a slot — which is fine until two genuinely different pictures are
 * both `720x576`.
 */
describe('computeLayoutKey', () => {
    it('says nothing extra about a square-pixel source', () => {
        // Every key written before display dimensions existed has to keep
        // matching, or every saved label is orphaned on upgrade. That is the
        // whole reason the token is conditional.
        expect(computeLayoutKey(probe([video()]), 'video')).toBe(
            'video|v:1920x1080:h264|a:aac:2:48000'
        );
    });

    it('is unchanged when the display size equals the coded size', () => {
        expect(
            computeLayoutKey(
                probe([video({ displayWidth: 1920, displayHeight: 1080 })]),
                'video'
            )
        ).toBe(computeLayoutKey(probe([video()]), 'video'));
    });

    it('separates 4:3 and 16:9 PAL SD, which used to share a slot', () => {
        const squarePal = probe([video({ width: 720, height: 576 })]);
        const widePal = probe([
            video({
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
            }),
        ]);

        expect(computeLayoutKey(squarePal, 'video')).toBe(
            'video|v:720x576:h264|a:aac:2:48000'
        );
        expect(computeLayoutKey(widePal, 'video')).toBe(
            'video|v:720x576@1024x576:h264|a:aac:2:48000'
        );
        expect(computeLayoutKey(squarePal, 'video')).not.toBe(
            computeLayoutKey(widePal, 'video')
        );
    });

    it('separates sources that correct on different axes', () => {
        const wide = probe([
            video({
                width: 720,
                height: 480,
                displayWidth: 960,
                displayHeight: 480,
            }),
        ]);
        const tall = probe([
            video({
                width: 720,
                height: 480,
                displayWidth: 720,
                displayHeight: 540,
            }),
        ]);

        expect(computeLayoutKey(wide, 'video')).not.toBe(
            computeLayoutKey(tall, 'video')
        );
    });

    it('marks each angle of a multi-track source independently', () => {
        expect(
            computeLayoutKey(
                probe([
                    video({ index: 0, width: 1920, height: 1080 }),
                    video({
                        index: 1,
                        width: 720,
                        height: 576,
                        displayWidth: 1024,
                        displayHeight: 576,
                    }),
                ]),
                'video'
            )
        ).toBe(
            'video|v:1920x1080:h264,720x576@1024x576:h264|a:aac:2:48000'
        );
    });

    it('leaves the audio-only key alone, which has no video in it', () => {
        expect(
            computeLayoutKey(
                probe([
                    video({
                        width: 720,
                        height: 576,
                        displayWidth: 1024,
                        displayHeight: 576,
                    }),
                ]),
                'audio'
            )
        ).toBe('audio|a:aac:2:48000');
    });
});

/**
 * The store itself. Both accessors swallow their errors deliberately — a
 * remembered ladder is a convenience, and a browser with storage disabled or a
 * corrupted entry must cost the user a suggestion, never the encode.
 */
describe('getStoredConfig / saveConfig', () => {
    const config = {
        type: 'video' as const,
        videoRenditions: [
            {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 5000,
                copyStream: false,
                audioGroupId: 'hd',
                vbr: true,
            },
        ],
        audioGroups: [
            {
                id: 'hd',
                audioBitrateKbps: 128,
                channels: 2,
                audioCodec: 'aac' as const,
                sourceTrackIndex: 0,
            },
        ],
    };

    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('round-trips a config under its layout key', () => {
        saveConfig('video|v:1920x1080:h264|a:aac:2:48000', config);
        expect(
            getStoredConfig('video|v:1920x1080:h264|a:aac:2:48000')
        ).toEqual(config);
    });

    it('keeps entries for different layouts side by side', () => {
        saveConfig('video|v:1920x1080:h264|a:aac:2:48000', config);
        saveConfig('video|v:720x576@1024x576:h264|a:aac:2:48000', config);
        expect(
            getStoredConfig('video|v:1920x1080:h264|a:aac:2:48000')
        ).toEqual(config);
        expect(
            getStoredConfig('video|v:720x576@1024x576:h264|a:aac:2:48000')
        ).toEqual(config);
    });

    it('returns null for a layout nothing was saved against', () => {
        saveConfig('video|v:1920x1080:h264|a:aac:2:48000', config);
        expect(getStoredConfig('video|v:720x576:h264|a:aac:2:48000')).toBeNull();
    });

    it('returns null when there is nothing stored at all', () => {
        expect(getStoredConfig('anything')).toBeNull();
    });

    it('returns null rather than throwing on a corrupted store', () => {
        localStorage.setItem('luminary_encode_configs', '{ not json');
        expect(getStoredConfig('anything')).toBeNull();
    });

    it('returns null when storage itself refuses to be read', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        expect(getStoredConfig('anything')).toBeNull();
    });

    it('swallows a write that storage refuses', () => {
        // Private browsing, or a full quota. Losing the suggestion is the whole
        // cost; the form carries on.
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        expect(() => saveConfig('k', config)).not.toThrow();
    });

    it('saves over a corrupted store instead of being stopped by it', () => {
        // The defect this replaced: both accessors parsed inside their own
        // single try, so a corrupted entry threw before the write and was
        // swallowed with it. The corruption was then permanent for that
        // browser — every later save silently did nothing.
        localStorage.setItem('luminary_encode_configs', 'garbage');

        saveConfig('k', config);

        expect(getStoredConfig('k')).toEqual(config);
        expect(localStorage.getItem('luminary_encode_configs')).not.toBe(
            'garbage'
        );
    });

    it('recovers from a store that parses but is not an object', () => {
        // `typeof null === 'object'` and an array indexes without complaining,
        // so neither can be left to reach the caller as an empty-looking store.
        for (const wrong of ['null', '[]', '"a string"', '42']) {
            localStorage.setItem('luminary_encode_configs', wrong);
            expect(getStoredConfig('k')).toBeNull();

            saveConfig('k', config);
            expect(getStoredConfig('k')).toEqual(config);
            localStorage.clear();
        }
    });

    it('keeps the other entries when it writes over a readable store', () => {
        // Replacing the blob is only licensed when it cannot be read. A store
        // that parses must not lose the layouts it already holds.
        saveConfig('first', config);
        saveConfig('second', config);

        expect(getStoredConfig('first')).toEqual(config);
        expect(getStoredConfig('second')).toEqual(config);
    });

    it('still gives up quietly when the write itself is refused', () => {
        // The corrupted-store path is now recoverable; a refused write is not,
        // and must stay silent rather than surfacing at the form.
        localStorage.setItem('luminary_encode_configs', 'garbage');
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });

        expect(() => saveConfig('k', config)).not.toThrow();
    });
});

/**
 * The content-preset store. It sits beside the config store rather than inside
 * it — the saved config is the very `EncodeConfig` the API validates with
 * `forbidNonWhitelisted` — and it is read the same way, for the same reasons.
 */
describe('getStoredContentPreset / saveContentPreset', () => {
    const hd = 'video|v:1920x1080:h264|a:aac:2:48000';
    const pal = 'video|v:720x576@1024x576:h264|a:aac:2:48000';
    const config = {
        type: 'video' as const,
        videoRenditions: [
            {
                width: 1920,
                height: 1080,
                videoBitrateKbps: 1805,
                copyStream: false,
                audioGroupId: 'hd',
                vbr: true,
            },
        ],
    };

    beforeEach(() => {
        localStorage.clear();
        vi.restoreAllMocks();
    });

    it('round-trips a preset under its layout key', () => {
        // The weekly service: the same camera and layout every Sunday should
        // open on the preset chosen last week, not back at Standard.
        saveContentPreset(hd, { preset: 'low' });
        expect(getStoredContentPreset(hd)).toEqual({ preset: 'low' });
    });

    it('keeps a custom factor with its preset', () => {
        // Below 0.6 is only reachable through Custom, so the factor is the
        // whole of what the operator chose; the id alone would lose it.
        saveContentPreset(hd, { preset: 'custom', customFactor: 0.45 });
        expect(getStoredContentPreset(hd)).toEqual({
            preset: 'custom',
            customFactor: 0.45,
        });
    });

    it('keeps presets for different layouts side by side', () => {
        // A service camera and an archive transfer are different material,
        // and remembering one must not overwrite the other.
        saveContentPreset(hd, { preset: 'low' });
        saveContentPreset(pal, { preset: 'high' });
        expect(getStoredContentPreset(hd)).toEqual({ preset: 'low' });
        expect(getStoredContentPreset(pal)).toEqual({ preset: 'high' });
    });

    it('replaces the preset remembered for a layout', () => {
        saveContentPreset(hd, { preset: 'low' });
        saveContentPreset(hd, { preset: 'standard' });
        expect(getStoredContentPreset(hd)).toEqual({ preset: 'standard' });
    });

    it('returns null for a layout nothing was saved against', () => {
        saveContentPreset(hd, { preset: 'low' });
        expect(getStoredContentPreset(pal)).toBeNull();
    });

    it('returns null when there is nothing stored at all', () => {
        expect(getStoredContentPreset(hd)).toBeNull();
    });

    it('writes under its own key and leaves the configs alone', () => {
        // A preset smuggled into the saved `EncodeConfig` would come back from
        // the API as a 400, not as a remembered setting.
        saveContentPreset(hd, { preset: 'low' });
        expect(
            JSON.parse(localStorage.getItem('luminary_content_presets')!)
        ).toEqual({ [hd]: { preset: 'low' } });
        expect(localStorage.getItem('luminary_encode_configs')).toBeNull();
        expect(getStoredConfig(hd)).toBeNull();
    });

    it('is left alone in turn when a config is saved', () => {
        saveConfig(hd, config);
        expect(localStorage.getItem('luminary_content_presets')).toBeNull();
        expect(getStoredContentPreset(hd)).toBeNull();

        saveContentPreset(hd, { preset: 'high' });
        saveConfig(hd, config);
        expect(getStoredContentPreset(hd)).toEqual({ preset: 'high' });
        expect(getStoredConfig(hd)).toEqual(config);
    });

    it('costs only the preset when its own store is corrupt', () => {
        // The other half of keeping them apart: one unreadable store must not
        // take the saved track labels down with it, nor they the preset.
        saveConfig(hd, config);
        localStorage.setItem('luminary_content_presets', '{ not json');
        expect(getStoredContentPreset(hd)).toBeNull();
        expect(getStoredConfig(hd)).toEqual(config);

        localStorage.clear();
        saveContentPreset(hd, { preset: 'low' });
        localStorage.setItem('luminary_encode_configs', '{ not json');
        expect(getStoredConfig(hd)).toBeNull();
        expect(getStoredContentPreset(hd)).toEqual({ preset: 'low' });
    });

    it('saves over a corrupted store instead of being stopped by it', () => {
        // The config store's old defect, not repeated here: a store that
        // cannot be parsed has nothing in it, and the next save is entitled to
        // replace it — otherwise one bad write loses the preset for good.
        localStorage.setItem('luminary_content_presets', '{ not json');
        expect(getStoredContentPreset(hd)).toBeNull();

        saveContentPreset(hd, { preset: 'low' });

        expect(getStoredContentPreset(hd)).toEqual({ preset: 'low' });
        expect(
            JSON.parse(localStorage.getItem('luminary_content_presets')!)
        ).toEqual({ [hd]: { preset: 'low' } });
    });

    it('recovers from a store that parses but is not an object', () => {
        // `typeof null === 'object'`, and an array indexes without complaint
        // but serialises without the layout keys set on it, so the save would
        // vanish; a string or number cannot take a key at all.
        for (const wrong of ['null', '[]', '"a string"', '42']) {
            localStorage.setItem('luminary_content_presets', wrong);
            expect(getStoredContentPreset(hd)).toBeNull();

            saveContentPreset(hd, { preset: 'high' });
            expect(getStoredContentPreset(hd)).toEqual({ preset: 'high' });
            localStorage.clear();
        }
    });

    it('keeps the other entries when it writes over a readable store', () => {
        // Replacing the blob is licensed only when it cannot be read.
        saveContentPreset(hd, { preset: 'low' });
        saveContentPreset(pal, { preset: 'high' });
        saveContentPreset(hd, { preset: 'custom', customFactor: 0.45 });

        expect(getStoredContentPreset(pal)).toEqual({ preset: 'high' });
    });

    it('returns null when storage itself refuses to be read', () => {
        // A private window, or a browser set to block site data: the form
        // opens on Standard, as it would on a first visit.
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        expect(getStoredContentPreset(hd)).toBeNull();
    });

    it('swallows a write that storage refuses', () => {
        // A full quota. The preset is a convenience, and the encode must not
        // be the price of failing to remember it.
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('QuotaExceededError');
        });
        expect(() => saveContentPreset(hd, { preset: 'low' })).not.toThrow();

        vi.restoreAllMocks();
        expect(getStoredContentPreset(hd)).toBeNull();
    });
});
