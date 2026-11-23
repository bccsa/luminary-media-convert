import { describe, expect, it } from 'vitest';
import type {
    AudioTrackInfo,
    ProbeResult,
    VideoTrackInfo,
} from '@luminary-media-converter/encode-config';
import {
    previewPlayability,
    type PlaybackCapabilities,
} from './previewPlayback';

const chromium: PlaybackCapabilities = {
    hevc: false,
    hevc10: false,
    audioTrackSwitching: true,
};

const video = (codec: string, pixFmt = 'yuv420p'): VideoTrackInfo =>
    ({
        index: 0,
        codec,
        pixFmt,
        width: 1920,
        height: 1080,
        bitrateKbps: 8000,
        frameRate: 25,
    }) as VideoTrackInfo;

const audio = (codec: string): AudioTrackInfo => ({
    index: 1,
    codec,
    bitrateKbps: 128,
    channels: 2,
    sampleRate: 48000,
});

const probe = (
    formatName: string,
    videoTracks: VideoTrackInfo[],
    audioTracks: AudioTrackInfo[]
): ProbeResult =>
    ({
        format: { duration: 20, bitrateKbps: 8000, formatName },
        videoTracks,
        audioTracks,
    }) as ProbeResult;

const MP4 = 'mov,mp4,m4a,3gp,3g2,mj2';

describe('previewPlayability', () => {
    it('plays an H.264 and AAC MP4 directly', () => {
        expect(
            previewPlayability(
                probe(MP4, [video('h264')], [audio('aac')]),
                chromium
            )
        ).toEqual({ direct: true });
    });

    it('plays a VP9 and Opus WebM directly', () => {
        expect(
            previewPlayability(
                probe('matroska,webm', [video('vp9')], [audio('opus')]),
                chromium
            )
        ).toEqual({ direct: true });
    });

    // Each pairing heard to play in Electron and Chrome before it went in.
    it.each([
        ['an H.264 and AAC MKV', 'matroska,webm', 'aac'],
        ['an H.264 and MP3 MKV', 'matroska,webm', 'mp3'],
        ['an H.264 and FLAC MKV', 'matroska,webm', 'flac'],
        ['an H.264 and Opus MKV', 'matroska,webm', 'opus'],
        ['an H.264 MOV with 16-bit PCM', MP4, 'pcm_s16le'],
        ['an H.264 MOV with 24-bit PCM', MP4, 'pcm_s24le'],
    ])('plays %s directly', (_, formatName, codec) => {
        expect(
            previewPlayability(
                probe(formatName, [video('h264')], [audio(codec)]),
                chromium
            )
        ).toEqual({ direct: true });
    });

    it.each([
        ['MP3', 'mp3', 'mp3'],
        ['FLAC', 'flac', 'flac'],
        ['WAV', 'wav', 'pcm_s16le'],
        ['24-bit WAV', 'wav', 'pcm_s24le'],
    ])('plays %s audio directly', (_, formatName, codec) => {
        expect(
            previewPlayability(probe(formatName, [], [audio(codec)]), chromium)
        ).toEqual({ direct: true });
    });

    describe('H.264 the browser cannot decode', () => {
        // High 10 and 4:2:2 are H.264 by name, and no browser plays them.
        it.each([
            ['yuv420p10le', '10-bit H.264 video'],
            ['yuv422p', '4:2:2 H.264 video'],
            ['yuv444p', '4:4:4 H.264 video'],
        ])('converts %s, saying why', (pixFmt, reason) => {
            expect(
                previewPlayability(
                    probe(MP4, [video('h264', pixFmt)], [audio('aac')]),
                    chromium
                )
            ).toEqual({ direct: false, reason });
        });
    });

    it('converts a rotated video, which the browser shows on its side', () => {
        // An iPhone portrait video: stored landscape, shown turned.
        const turned = {
            ...video('h264'),
            displayWidth: 1080,
            displayHeight: 1920,
            rotation: 90,
        } as VideoTrackInfo;
        expect(
            previewPlayability(probe(MP4, [turned], [audio('aac')]), chromium)
        ).toEqual({ direct: false, reason: 'Rotated video' });
    });

    describe('HEVC, which needs a platform decoder', () => {
        it('converts it where the browser has none', () => {
            expect(
                previewPlayability(
                    probe(MP4, [video('hevc')], [audio('aac')]),
                    chromium
                )
            ).toEqual({ direct: false, reason: 'HEVC video' });
        });

        it('plays 8-bit directly where the browser decodes it', () => {
            expect(
                previewPlayability(
                    probe(MP4, [video('hevc')], [audio('aac')]),
                    {
                        ...chromium,
                        hevc: true,
                    }
                )
            ).toEqual({ direct: true });
        });

        it('plays 10-bit only where 10-bit decodes too', () => {
            const tenBit = probe(
                MP4,
                [video('hevc', 'yuv420p10le')],
                [audio('aac')]
            );
            expect(
                previewPlayability(tenBit, { ...chromium, hevc: true }).direct
            ).toBe(false);
            expect(
                previewPlayability(tenBit, {
                    ...chromium,
                    hevc: true,
                    hevc10: true,
                }).direct
            ).toBe(true);
        });
    });

    describe('codecs refused for their container, not for themselves', () => {
        // "HEVC video" alone would read as though HEVC does not play.
        it('names the container for HEVC in MKV', () => {
            expect(
                previewPlayability(
                    probe('matroska,webm', [video('hevc')], [audio('aac')]),
                    { ...chromium, hevc: true }
                )
            ).toEqual({ direct: false, reason: 'HEVC video in MKV' });
        });

        it('names the container for PCM in MKV', () => {
            expect(
                previewPlayability(
                    probe(
                        'matroska,webm',
                        [video('h264')],
                        [audio('pcm_s16le')]
                    ),
                    chromium
                )
            ).toEqual({ direct: false, reason: 'PCM audio in MKV' });
        });
    });

    // In an MKV these play as a picture in silence, with no error to fall back
    // on, so they must never be let through to direct play.
    it.each([
        ['AC-3', 'ac3', 'AC-3 audio'],
        ['E-AC-3', 'eac3', 'E-AC-3 audio'],
    ])('converts an H.264 MKV with %s audio', (_, codec, reason) => {
        expect(
            previewPlayability(
                probe('matroska,webm', [video('h264')], [audio(codec)]),
                chromium
            )
        ).toEqual({ direct: false, reason });
    });

    it.each([
        [
            'big-endian PCM, which plays nowhere',
            MP4,
            'h264',
            'pcm_s16be',
            'PCM audio',
        ],
        ['AC-3 audio', MP4, 'h264', 'ac3', 'AC-3 audio'],
        ['ProRes video', MP4, 'prores', 'pcm_s16le', 'ProRes video'],
        ['an MPEG-TS file', 'mpegts', 'h264', 'aac', 'MPEG-TS container'],
        ['an MPEG-PS file', 'mpeg', 'mpeg2video', 'mp2', 'MPEG-PS container'],
        ['an unknown container', 'xyz', 'h264', 'aac', 'XYZ container'],
    ])('converts %s, saying why', (_, formatName, v, a, reason) => {
        expect(
            previewPlayability(
                probe(formatName, [video(v)], [audio(a)]),
                chromium
            )
        ).toEqual({ direct: false, reason });
    });

    it('checks every stream, not only the first', () => {
        expect(
            previewPlayability(
                probe(MP4, [video('h264')], [audio('aac'), audio('ac3')]),
                chromium
            )
        ).toEqual({ direct: false, reason: 'AC-3 audio' });
    });

    it('converts several audio tracks where the browser cannot switch between them', () => {
        expect(
            previewPlayability(
                probe(MP4, [video('h264')], [audio('aac'), audio('aac')]),
                {
                    ...chromium,
                    audioTrackSwitching: false,
                }
            )
        ).toEqual({ direct: false, reason: 'several audio tracks' });
    });

    it('converts a file with no streams to play', () => {
        expect(previewPlayability(probe(MP4, [], []), chromium)).toEqual({
            direct: false,
            reason: 'no playable streams',
        });
    });

    it('converts a stream whose pixel format the probe did not report', () => {
        expect(
            previewPlayability(
                probe(
                    MP4,
                    [{ ...video('h264'), pixFmt: undefined }],
                    [audio('aac')]
                ),
                chromium
            )
        ).toEqual({ direct: false, reason: 'Unknown-format H.264 video' });
    });

    it('converts a probe that names no container', () => {
        expect(
            previewPlayability(
                {
                    ...probe('', [video('h264')], [audio('aac')]),
                    format: undefined,
                } as any,
                chromium
            )
        ).toEqual({ direct: false, reason: 'unknown container' });
    });
});
