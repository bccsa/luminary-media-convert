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
