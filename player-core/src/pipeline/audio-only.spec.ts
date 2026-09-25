import { describe, expect, it } from 'vitest';
import { parseMasterPlaylist } from '@luminary-media-converter/hls-core';
import {
    buildAudioOnlyMaster,
    canRenderAudioOnly,
    hasAudioOnlyRendering,
    isAudioOnlyMaster,
    referencedPlaylistUris,
} from './audio-only.js';
import { parseMasterText } from './playlist-text.js';
import {
    AUDIO_ONLY_MASTER,
    MULTI_ANGLE_MASTER,
    SIMPLE_MASTER,
} from '../test-support/index.js';

describe('audio-only pseudo-angle', () => {
    it('is offered for masters that carry audio rendition groups', () => {
        expect(hasAudioOnlyRendering(MULTI_ANGLE_MASTER)).toBe(true);
        expect(hasAudioOnlyRendering(SIMPLE_MASTER)).toBe(true);
    });

    it('downloads NO video: the munged master has zero video renditions', () => {
        const munged = buildAudioOnlyMaster(MULTI_ANGLE_MASTER);
        expect(munged).not.toBeNull();

        const parsed = parseMasterText(munged!);
        // Hard requirement from the plan — nothing video-shaped survives.
        expect(parsed.media.filter((m) => m.type === 'VIDEO')).toEqual([]);
        expect(parsed.variants.every((v) => v.height === undefined)).toBe(true);
        expect(parsed.variants.every((v) => v.groups.VIDEO === undefined)).toBe(
            true,
        );
        expect(isAudioOnlyMaster(munged!)).toBe(true);
    });

    it('leaves no video playlist URI for the engine to fetch', () => {
        const munged = buildAudioOnlyMaster(MULTI_ANGLE_MASTER)!;
        const videoUris = referencedPlaylistUris(MULTI_ANGLE_MASTER).filter(
            (uri) => uri.startsWith('angle'),
        );
        expect(videoUris.length).toBeGreaterThan(0);

        const survivors = referencedPlaylistUris(munged);
        expect(survivors).toEqual(['audio_128kbps/playlist.m3u8']);
        for (const uri of videoUris) expect(munged).not.toContain(uri);
    });

    it('promotes one variant per audio group of a multi-tier master', () => {
        const munged = buildAudioOnlyMaster(SIMPLE_MASTER)!;
        const parsed = parseMasterText(munged);
        expect(parsed.variants.map((v) => v.uri)).toEqual([
            'audio_hi_128kbps/playlist.m3u8',
            'audio_lo_64kbps/playlist.m3u8',
        ]);
        expect(munged).not.toContain('stream_1080');
    });

    it('recognizes a natively audio-only master', () => {
        expect(isAudioOnlyMaster(AUDIO_ONLY_MASTER)).toBe(true);
        expect(isAudioOnlyMaster(SIMPLE_MASTER)).toBe(false);
    });

    it('is offered exactly when an audio-only master can be built', () => {
        // Asked of the model rather than built and thrown away — which makes
        // agreeing with the build the whole of what the question must do.
        const muxedAudio = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES',
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,AUDIO="aud"',
            'v720/playlist.m3u8',
            '',
        ].join('\n');
        const noGroup = [
            '#EXTM3U',
            '#EXT-X-MEDIA:TYPE=AUDIO,NAME="English",URI="audio/playlist.m3u8"',
            '#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720',
            'v720/playlist.m3u8',
            '',
        ].join('\n');

        for (const master of [
            MULTI_ANGLE_MASTER,
            SIMPLE_MASTER,
            AUDIO_ONLY_MASTER,
            muxedAudio,
            noGroup,
        ]) {
            const buildable = buildAudioOnlyMaster(master) !== null;
            expect(hasAudioOnlyRendering(master)).toBe(buildable);
            expect(canRenderAudioOnly(parseMasterPlaylist(master))).toBe(
                buildable,
            );
        }
        // Audio muxed into the video has no rendition of its own to promote.
        expect(hasAudioOnlyRendering(muxedAudio)).toBe(false);
        expect(hasAudioOnlyRendering(noGroup)).toBe(false);
    });
});
