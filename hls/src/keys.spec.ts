import { describe, it, expect } from 'vitest';
import { normalizeS3Key, deriveAngleName } from './keys';

describe('normalizeS3Key', () => {
    it('returns bare keys unchanged', () => {
        expect(normalizeS3Key('path/to/master.m3u8', 'bucket')).toBe('path/to/master.m3u8');
    });

    it('strips scheme, host, and bucket from a full URL', () => {
        expect(normalizeS3Key('http://localhost:9000/media/a/b/master.m3u8', 'media')).toBe('a/b/master.m3u8');
    });

    it('strips leading slashes', () => {
        expect(normalizeS3Key('/a/b/master.m3u8', 'bucket')).toBe('a/b/master.m3u8');
    });

    it('strips a leading bucket/ prefix', () => {
        expect(normalizeS3Key('bucket/a/b/master.m3u8', 'bucket')).toBe('a/b/master.m3u8');
    });

    it('leaves non-matching bucket alone', () => {
        expect(normalizeS3Key('other-bucket/file.m3u8', 'bucket')).toBe('other-bucket/file.m3u8');
    });

    it('trims whitespace', () => {
        expect(normalizeS3Key('  a/b.m3u8  ', 'bucket')).toBe('a/b.m3u8');
    });
});

describe('deriveAngleName', () => {
    it('uses the filename stem', () => {
        expect(deriveAngleName('prefix/main.m3u8', 'prefix/', 0)).toBe('main');
    });

    it('replaces underscores with spaces', () => {
        expect(deriveAngleName('prefix/audio_only.m3u8', 'prefix/', 0)).toBe('audio only');
    });

    it('handles a key with no folder segment', () => {
        expect(deriveAngleName('pulpit.m3u8', '', 2)).toBe('pulpit');
    });

    it('falls back to Angle N when stem is empty', () => {
        expect(deriveAngleName('.m3u8', '', 4)).toBe('Angle 5');
    });
});
