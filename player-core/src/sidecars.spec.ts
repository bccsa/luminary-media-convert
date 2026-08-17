import { describe, expect, it } from 'vitest';
import {
    SidecarLoader,
    chapterTrackId,
    pickDefaultChapterTrack,
    subtitleSidecarId,
} from './sidecars.js';
import type { ChapterTrack } from './types.js';
import {
    CHAPTERS_VTT,
    FakeServeStrategy,
    TEST_KEY_HEX,
    encryptLmcenc,
    makeFetch,
} from './test-support/index.js';

const EN = 'https://cdn.example.com/out/chapters/en.vtt';
const FR = 'https://cdn.example.com/out/chapters/fr.vtt';

const FR_VTT = [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:01:30.500',
    'Ouverture',
    '',
].join('\n');

const tracks: ChapterTrack[] = [
    { id: chapterTrackId('en'), lang: 'en', label: 'English' },
    { id: chapterTrackId('fr'), lang: 'fr', label: 'Français' },
];

describe('pickDefaultChapterTrack', () => {
    it('follows the active audio language', () => {
        expect(pickDefaultChapterTrack(tracks, 'fr')).toBe(
            chapterTrackId('fr'),
        );
    });

    it('matches on the base language of a regional tag', () => {
        expect(pickDefaultChapterTrack(tracks, 'fr-CA')).toBe(
            chapterTrackId('fr'),
        );
    });

    it('falls back to the first track', () => {
        expect(pickDefaultChapterTrack(tracks, 'de')).toBe(
            chapterTrackId('en'),
        );
        expect(pickDefaultChapterTrack(tracks)).toBe(chapterTrackId('en'));
    });

    it('returns null when there are no chapter tracks', () => {
        expect(pickDefaultChapterTrack([], 'en')).toBeNull();
    });
});

describe('SidecarLoader — chapters', () => {
    function loader(
        routes: Record<string, string | Uint8Array>,
        keyHex?: string,
    ) {
        const { fetchImpl, calls } = makeFetch(routes);
        const serveStrategy = new FakeServeStrategy();
        return {
            calls,
            serveStrategy,
            loader: new SidecarLoader({ fetchImpl, serveStrategy, keyHex }),
        };
    }

    it('exposes one track per language', () => {
        const h = loader({ [EN]: CHAPTERS_VTT });
        h.loader.setChapters([
            { lang: 'en', label: 'English', url: EN },
            { lang: 'fr', url: FR },
        ]);
        expect(h.loader.chapterTracks()).toEqual([
            { id: 'c:en', lang: 'en', label: 'English' },
            { id: 'c:fr', lang: 'fr', label: 'fr' },
        ]);
    });

    it('loads lazily, only the language asked for, and caches it', async () => {
        const h = loader({ [EN]: CHAPTERS_VTT, [FR]: FR_VTT });
        h.loader.setChapters([
            { lang: 'en', url: EN },
            { lang: 'fr', url: FR },
        ]);
        expect(h.calls).toEqual([]);

        const en = await h.loader.loadChapters('c:en');
        expect(en).toHaveLength(2);
        expect(h.calls).toEqual([EN]);

        await h.loader.loadChapters('c:en');
        expect(h.calls).toEqual([EN]);

        const fr = await h.loader.loadChapters('c:fr');
        expect(fr[0]?.title).toBe('Ouverture');
        expect(h.calls).toEqual([EN, FR]);
    });

    it('handles the single-language passthrough case', async () => {
        const h = loader({ [EN]: CHAPTERS_VTT });
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        expect(h.loader.chapterTracks()).toHaveLength(1);
        expect(await h.loader.loadChapters('c:en')).toHaveLength(2);
    });

    it('decrypts LMCENC chapter files', async () => {
        const h = loader({ [EN]: encryptLmcenc(CHAPTERS_VTT) }, TEST_KEY_HEX);
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        expect(await h.loader.loadChapters('c:en')).toHaveLength(2);
    });

    it('reads plaintext chapter files even when a key is configured', async () => {
        const h = loader({ [EN]: CHAPTERS_VTT }, TEST_KEY_HEX);
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        expect(await h.loader.loadChapters('c:en')).toHaveLength(2);
    });

    it('yields nothing for an unknown track id', async () => {
        const h = loader({ [EN]: CHAPTERS_VTT });
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        expect(await h.loader.loadChapters('c:de')).toEqual([]);
        expect(h.calls).toEqual([]);
    });

    it('drops the cache when the sidecar set is replaced', async () => {
        const h = loader({ [EN]: CHAPTERS_VTT });
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        await h.loader.loadChapters('c:en');
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        await h.loader.loadChapters('c:en');
        expect(h.calls).toEqual([EN, EN]);
    });

    it('surfaces a missing chapter file as a typed error', async () => {
        const h = loader({});
        h.loader.setChapters([{ lang: 'en', url: EN }]);
        await expect(h.loader.loadChapters('c:en')).rejects.toMatchObject({
            code: 'fetch-failed',
        });
    });
});

describe('SidecarLoader — subtitles', () => {
    it('serves decrypted sidecar subtitles as engine text tracks', async () => {
        const { fetchImpl } = makeFetch({ [EN]: encryptLmcenc(CHAPTERS_VTT) });
        const serveStrategy = new FakeServeStrategy();
        const loader = new SidecarLoader({
            fetchImpl,
            serveStrategy,
            keyHex: TEST_KEY_HEX,
        });

        const { tracks: subtitleTracks, adapterTracks } =
            await loader.loadSubtitleTracks([
                { lang: 'en', label: 'English', url: EN },
            ]);

        expect(subtitleTracks[0]).toEqual({
            id: subtitleSidecarId('en'),
            lang: 'en',
            label: 'English',
            source: 'sidecar',
        });
        expect(serveStrategy.textOf(adapterTracks[0]!.blobUrl)).toBe(
            CHAPTERS_VTT,
        );
    });

    it('returns empty lists when there are no sidecars', async () => {
        const { fetchImpl } = makeFetch({});
        const loader = new SidecarLoader({
            fetchImpl,
            serveStrategy: new FakeServeStrategy(),
        });
        expect(await loader.loadSubtitleTracks(undefined)).toEqual({
            tracks: [],
            adapterTracks: [],
        });
    });
});

describe('SidecarLoader — scrub thumbnails', () => {
    const VTT_URL = 'https://cdn.example.com/out/thumbnails.vtt';

    const THUMBS_VTT = [
        'WEBVTT',
        '',
        '00:00:00.000 --> 00:00:10.000',
        'sprite_0.jpg#xywh=0,0,160,90',
        '',
        '00:00:10.000 --> 00:00:20.000',
        'sprite_0.jpg#xywh=160,0,160,90',
        '',
    ].join('\n');

    function loader(
        routes: Record<string, string | Uint8Array>,
        keyHex?: string,
    ) {
        const { fetchImpl, calls } = makeFetch(routes);
        return {
            calls,
            loader: new SidecarLoader({
                fetchImpl,
                serveStrategy: new FakeServeStrategy(),
                keyHex,
            }),
        };
    }

    it('parses cues and resolves sprites against the VTT directory', async () => {
        // The sprite reference is relative in every file the encoder writes, so
        // getting the base wrong is the difference between a preview and a
        // silent 404 per frame.
        const h = loader({ [VTT_URL]: THUMBS_VTT });

        const cues = await h.loader.loadThumbnails({ url: VTT_URL });

        expect(cues).toHaveLength(2);
        expect(cues[0]?.spriteUrl).toBe(
            'https://cdn.example.com/out/sprite_0.jpg',
        );
        expect(cues[1]).toMatchObject({ x: 160, y: 0, w: 160, h: 90 });
    });

    it('decrypts an LMCENC sidecar, as an encrypted session writes it', async () => {
        // Since #162 an encrypted session wraps every .vtt it writes, this one
        // included. The sprite images stay plain JPEGs.
        const h = loader({ [VTT_URL]: encryptLmcenc(THUMBS_VTT) }, TEST_KEY_HEX);

        expect(await h.loader.loadThumbnails({ url: VTT_URL })).toHaveLength(2);
    });

    it('reads a plaintext sidecar even when a key is configured', async () => {
        const h = loader({ [VTT_URL]: THUMBS_VTT }, TEST_KEY_HEX);

        expect(await h.loader.loadThumbnails({ url: VTT_URL })).toHaveLength(2);
    });

    it('yields nothing, quietly, for every way there can be no preview', async () => {
        /*
         * No sidecar passed, and a sidecar that is not there — a session encoded
         * with `thumbnails: false`, or an audio-only encode. Neither is something
         * a viewer can act on, so both are an empty list rather than an error
         * the host has to catch and ignore.
         */
        const h = loader({ [VTT_URL]: THUMBS_VTT });

        expect(await h.loader.loadThumbnails(undefined)).toEqual([]);
        expect(
            await h.loader.loadThumbnails({ url: 'https://cdn.example.com/nope.vtt' }),
        ).toEqual([]);
    });

    it('does not fetch when there is no sidecar to fetch', async () => {
        const h = loader({ [VTT_URL]: THUMBS_VTT });

        await h.loader.loadThumbnails(undefined);

        expect(h.calls).toEqual([]);
    });
});
