import {
    ALLOWED_EXTENSIONS,
    hasAllowedExtension,
    extensionFromContentType,
} from './media-extensions.js';

describe('media-extensions', () => {
    describe('ALLOWED_EXTENSIONS', () => {
        it('contains common video container extensions', () => {
            expect(ALLOWED_EXTENSIONS.has('.mp4')).toBe(true);
            expect(ALLOWED_EXTENSIONS.has('.mkv')).toBe(true);
            expect(ALLOWED_EXTENSIONS.has('.mov')).toBe(true);
            expect(ALLOWED_EXTENSIONS.has('.webm')).toBe(true);
        });

        it('contains common audio container extensions', () => {
            expect(ALLOWED_EXTENSIONS.has('.mp3')).toBe(true);
            expect(ALLOWED_EXTENSIONS.has('.wav')).toBe(true);
            expect(ALLOWED_EXTENSIONS.has('.aac')).toBe(true);
            expect(ALLOWED_EXTENSIONS.has('.flac')).toBe(true);
        });

        it('uses lowercase, dot-prefixed entries', () => {
            for (const ext of ALLOWED_EXTENSIONS) {
                expect(ext.startsWith('.')).toBe(true);
                expect(ext).toBe(ext.toLowerCase());
            }
        });
    });

    describe('hasAllowedExtension', () => {
        it('accepts allowed extensions', () => {
            expect(hasAllowedExtension('video.mp4')).toBe(true);
            expect(hasAllowedExtension('movie.MKV')).toBe(true);
            expect(hasAllowedExtension('audio.flac')).toBe(true);
        });

        it('is case-insensitive', () => {
            expect(hasAllowedExtension('VIDEO.MP4')).toBe(true);
            expect(hasAllowedExtension('VIDEO.Mp4')).toBe(true);
            expect(hasAllowedExtension('audio.OGG')).toBe(true);
        });

        it('rejects disallowed extensions', () => {
            expect(hasAllowedExtension('malware.exe')).toBe(false);
            expect(hasAllowedExtension('document.pdf')).toBe(false);
            expect(hasAllowedExtension('archive.zip')).toBe(false);
        });

        it('rejects filenames with no extension', () => {
            expect(hasAllowedExtension('README')).toBe(false);
            expect(hasAllowedExtension('')).toBe(false);
        });

        it('uses only the final extension when multiple dots are present', () => {
            expect(hasAllowedExtension('archive.tar.gz')).toBe(false);
            expect(hasAllowedExtension('episode.s01.e02.mp4')).toBe(true);
        });

        it('handles paths and only checks the basename suffix', () => {
            // Note: callers are expected to pass a basename, but the suffix
            // check still works on full paths.
            expect(hasAllowedExtension('/tmp/uploads/movie.mp4')).toBe(true);
            expect(hasAllowedExtension('subdir/file.exe')).toBe(false);
        });

        it('rejects a leading-dot file with no real extension', () => {
            // '.gitignore' has lastIndexOf('.') === 0 and the slice is the whole string.
            expect(hasAllowedExtension('.gitignore')).toBe(false);
        });
    });

    describe('extensionFromContentType', () => {
        it('maps common video MIME types to extensions', () => {
            expect(extensionFromContentType('video/mp4')).toBe('.mp4');
            expect(extensionFromContentType('video/quicktime')).toBe('.mov');
            expect(extensionFromContentType('video/x-matroska')).toBe('.mkv');
            expect(extensionFromContentType('video/webm')).toBe('.webm');
        });

        it('maps common audio MIME types to extensions', () => {
            expect(extensionFromContentType('audio/mpeg')).toBe('.mp3');
            expect(extensionFromContentType('audio/wav')).toBe('.wav');
            expect(extensionFromContentType('audio/flac')).toBe('.flac');
        });

        it('strips parameters like charset', () => {
            expect(extensionFromContentType('video/mp4; charset=binary')).toBe('.mp4');
        });

        it('is case-insensitive', () => {
            expect(extensionFromContentType('VIDEO/MP4')).toBe('.mp4');
            expect(extensionFromContentType('Audio/MPEG')).toBe('.mp3');
        });

        it('returns null for unknown MIME types', () => {
            expect(extensionFromContentType('application/octet-stream')).toBeNull();
            expect(extensionFromContentType('text/html')).toBeNull();
        });

        it('returns null for empty / nullish input', () => {
            expect(extensionFromContentType(null)).toBeNull();
            expect(extensionFromContentType(undefined)).toBeNull();
            expect(extensionFromContentType('')).toBeNull();
        });
    });
});
