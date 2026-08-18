import { describe, it, expect } from 'vitest';
import { isYouTubeUrl, extractYouTubeId, toVideoJsYouTubeUrl } from '../src/youtube';

const ID = 'dQw4w9WgXcQ';

describe('YouTube URL recognition', () => {
    it.each([
        `https://www.youtube.com/watch?v=${ID}`,
        `http://youtube.com/watch?v=${ID}`,
        `www.youtube.com/watch?v=${ID}`,
        `https://www.youtube.com/embed/${ID}`,
        `https://www.youtube.com/e/${ID}`,
        `https://www.youtube.com/v/${ID}`,
        `https://youtu.be/${ID}`,
        `https://www.youtube.com/watch?list=PL123&v=${ID}`,
    ])('recognises %s', (url) => {
        expect(isYouTubeUrl(url)).toBe(true);
        expect(extractYouTubeId(url)).toBe(ID);
    });

    it.each([
        'https://cdn.example.com/media/abc/master.m3u8',
        'https://vimeo.com/123456789',
        'https://youtube.com/watch?v=tooshort',
        '',
    ])('does not recognise %s', (url) => {
        expect(isYouTubeUrl(url)).toBe(false);
        expect(extractYouTubeId(url)).toBeNull();
    });

    it('handles a missing URL', () => {
        expect(isYouTubeUrl(null)).toBe(false);
        expect(extractYouTubeId(undefined)).toBeNull();
    });
});

describe('toVideoJsYouTubeUrl', () => {
    it('normalises every form to the canonical watch URL', () => {
        // The plugin resolves a short link through an extra in-iframe redirect,
        // so it is always handed the same shape.
        expect(toVideoJsYouTubeUrl(`https://youtu.be/${ID}`)).toBe(
            `https://www.youtube.com/watch?v=${ID}`,
        );
        expect(toVideoJsYouTubeUrl(`https://www.youtube.com/embed/${ID}`)).toBe(
            `https://www.youtube.com/watch?v=${ID}`,
        );
    });

    it('drops the playlist and other query parameters', () => {
        expect(toVideoJsYouTubeUrl(`https://www.youtube.com/watch?v=${ID}&t=42s`)).toBe(
            `https://www.youtube.com/watch?v=${ID}`,
        );
    });

    it('leaves a non-YouTube URL untouched', () => {
        // The caller has already decided the mode; rewriting it would be a lie.
        const url = 'https://cdn.example.com/media/abc/master.m3u8';
        expect(toVideoJsYouTubeUrl(url)).toBe(url);
    });
});
