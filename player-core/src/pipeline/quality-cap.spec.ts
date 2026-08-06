import { describe, expect, it } from 'vitest';
import { applyQualityCap, listQualities, toQuality } from './quality-cap.js';
import { parseMasterText } from './playlist-text.js';
import {
    AUDIO_ONLY_MASTER,
    MULTI_ANGLE_MASTER,
    SIMPLE_MASTER,
} from '../test-support/index.js';

const heights = (text: string) =>
    parseMasterText(text).variants.map((v) => v.height);
const groupIds = (text: string) =>
    parseMasterText(text).media.map((m) => m.groupId);

describe('applyQualityCap', () => {
    it('is the identity when no cap is set', () => {
        expect(applyQualityCap(SIMPLE_MASTER)).toBe(SIMPLE_MASTER);
        expect(applyQualityCap(SIMPLE_MASTER, 0)).toBe(SIMPLE_MASTER);
    });

    it('is the identity when every variant is already at or below the cap', () => {
        expect(applyQualityCap(SIMPLE_MASTER, 2160)).toBe(SIMPLE_MASTER);
    });

    it('keeps only variants at or below the cap', () => {
        expect(heights(applyQualityCap(SIMPLE_MASTER, 720))).toEqual([
            720, 480,
        ]);
    });

    it('keeps the single lowest variant when nothing qualifies', () => {
        const capped = applyQualityCap(SIMPLE_MASTER, 240);
        expect(heights(capped)).toEqual([480]);
    });

    it('garbage-collects media groups no surviving variant references', () => {
        // 480p uses aud_lo only, so aud_hi must go.
        const capped = applyQualityCap(SIMPLE_MASTER, 480);
        expect(heights(capped)).toEqual([480]);
        expect(groupIds(capped)).toEqual(['aud_lo']);
    });

    it('never orphans a referenced group', () => {
        const capped = applyQualityCap(SIMPLE_MASTER, 720);
        // 720p → aud_hi, 480p → aud_lo: both stay.
        expect(groupIds(capped)).toEqual(['aud_hi', 'aud_lo']);
    });

    it('keeps VIDEO and SUBTITLES groups still referenced after capping', () => {
        const capped = applyQualityCap(MULTI_ANGLE_MASTER, 720);
        expect(heights(capped)).toEqual([720]);
        // Only angle_0 survives at 720p; angle_1 is dropped with its variant.
        expect(groupIds(capped)).toEqual(['angle_0', 'aud', 'subs']);
    });

    it('always keeps resolution-less variants', () => {
        expect(applyQualityCap(AUDIO_ONLY_MASTER, 240)).toBe(AUDIO_ONLY_MASTER);
    });

    it('preserves untouched lines verbatim', () => {
        const capped = applyQualityCap(SIMPLE_MASTER, 720);
        expect(capped).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
        expect(capped).toContain('#EXT-X-VERSION:7');
        expect(capped).not.toContain('stream_1080/playlist.m3u8');
    });

    it('carries unmodeled tags and attributes past the cap', () => {
        const master = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-INDEPENDENT-SEGMENTS',
            '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Demo"',
            '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",URI="audio/playlist.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud",CLOSED-CAPTIONS="cc"',
            'v1080/playlist.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,FRAME-RATE=29.970,HDCP-LEVEL=TYPE-0,AUDIO="aud",CLOSED-CAPTIONS="cc"',
            'v720/playlist.m3u8',
            '',
        ].join('\n');

        const capped = applyQualityCap(master, 720);
        expect(capped).not.toContain('v1080/playlist.m3u8');
        expect(capped).toContain(
            '#EXT-X-SESSION-DATA:DATA-ID="com.example.title",VALUE="Demo"',
        );
        expect(capped).toContain('FRAME-RATE=29.970');
        expect(capped).toContain('HDCP-LEVEL=TYPE-0');
        expect(capped).toContain('CLOSED-CAPTIONS="cc"');
    });

    it('never garbage-collects a CLOSED-CAPTIONS group', () => {
        // The model carries CLOSED-CAPTIONS through verbatim but does not
        // surface it on a variant, so GC must not judge the group at all.
        const master = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",INSTREAM-ID="CC1"',
            '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CLOSED-CAPTIONS="cc"',
            'v1080/playlist.m3u8',
            '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=854x480',
            'v480/playlist.m3u8',
            '',
        ].join('\n');

        const capped = applyQualityCap(master, 480);
        expect(capped).not.toContain('v1080/playlist.m3u8');
        expect(capped).toContain('TYPE=CLOSED-CAPTIONS');
    });
});

describe('listQualities', () => {
    it('reports contract-shaped ids, sorted best first', () => {
        expect(listQualities(SIMPLE_MASTER)).toEqual([
            { id: '1080', height: 1080, bandwidth: 5_000_000, label: '1080p' },
            { id: '720', height: 720, bandwidth: 2_500_000, label: '720p' },
            { id: '480', height: 480, bandwidth: 1_000_000, label: '480p' },
        ]);
    });

    it('uses a bandwidth id for resolution-less variants', () => {
        expect(listQualities(AUDIO_ONLY_MASTER)).toEqual([
            { id: 'b128000', bandwidth: 128_000, label: '128 kbps' },
        ]);
    });

    it('collapses duplicate heights, keeping the richest variant', () => {
        // Both angles ship 1080p; the quality list must not show it twice.
        const qualities = listQualities(MULTI_ANGLE_MASTER);
        expect(qualities.map((q) => q.id)).toEqual(['1080', '720']);
    });
});

describe('toQuality', () => {
    it('labels audio-ish variants without a bitrate as "Audio"', () => {
        expect(toQuality(undefined, 0)).toEqual({
            id: 'b0',
            bandwidth: 0,
            label: 'Audio',
        });
    });
});
