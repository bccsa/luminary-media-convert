import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockStart = vi.fn();
const mockAbort = vi.fn();

vi.mock('tus-js-client', () => {
    const Upload = vi.fn(function (this: any) {
        this.start = mockStart;
        this.abort = mockAbort;
    });
    return { Upload };
});

import * as tus from 'tus-js-client';
import { uploadFile } from './api';

describe('uploadFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes removeFingerprintOnSuccess: true to tus Upload', () => {
        const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
        uploadFile('https://example.com/tus', 'sess-1', 'tok-1', file);

        expect(tus.Upload).toHaveBeenCalledWith(
            file,
            expect.objectContaining({
                removeFingerprintOnSuccess: true,
            }),
        );
    });

    it('passes endpoint, retryDelays, metadata, headers, and chunkSize', () => {
        const file = new File(['data'], 'test.mp4', { type: 'video/mp4' });
        uploadFile('https://example.com/tus', 'sess-1', 'tok-1', file);

        expect(tus.Upload).toHaveBeenCalledWith(
            file,
            expect.objectContaining({
                endpoint: 'https://example.com/tus',
                retryDelays: [0, 1000, 3000, 5000],
                chunkSize: 50 * 1024 * 1024,
                metadata: {
                    sessionId: 'sess-1',
                    filename: 'test.mp4',
                    filetype: 'video/mp4',
                },
                headers: {
                    Authorization: 'Bearer tok-1',
                },
            }),
        );
    });

    it('calls upload.start()', () => {
        const file = new File(['data'], 'test.mp4');
        uploadFile('https://example.com/tus', 'sess-1', 'tok-1', file);

        expect(mockStart).toHaveBeenCalled();
    });
});
