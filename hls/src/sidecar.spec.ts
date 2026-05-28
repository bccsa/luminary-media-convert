import { describe, it, expect } from 'vitest';
import { sidecarPath } from './sidecar';

describe('sidecarPath', () => {
    it('places subtitle VTTs under subtitles/ next to the master', () => {
        expect(sidecarPath('output/session/master.m3u8', 'subtitles', 'en.vtt'))
            .toBe('output/session/subtitles/en.vtt');
    });

    it('places chapters.vtt next to the master (filename ignored)', () => {
        expect(sidecarPath('output/session/master.m3u8', 'chapters', 'anything.vtt'))
            .toBe('output/session/chapters.vtt');
    });

    it('places waveform.json next to the master (filename ignored)', () => {
        expect(sidecarPath('output/session/master.m3u8', 'waveform', 'anything.json'))
            .toBe('output/session/waveform.json');
    });

    it('handles a master at the bucket root', () => {
        expect(sidecarPath('master.m3u8', 'subtitles', 'en.vtt'))
            .toBe('subtitles/en.vtt');
        expect(sidecarPath('master.m3u8', 'chapters', ''))
            .toBe('chapters.vtt');
        expect(sidecarPath('master.m3u8', 'waveform', ''))
            .toBe('waveform.json');
    });
});
