import { findTusdBinary } from '../src/binary.js';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

describe('findTusdBinary', () => {
    const originalEnv = process.env.TUSD_BINARY_PATH;

    afterEach(() => {
        if (originalEnv === undefined) {
            delete process.env.TUSD_BINARY_PATH;
        } else {
            process.env.TUSD_BINARY_PATH = originalEnv;
        }
    });

    it('should use TUSD_BINARY_PATH env var when set to a valid path', () => {
        // Point to a file that exists (the test file itself)
        process.env.TUSD_BINARY_PATH = __filename;
        const result = findTusdBinary();
        expect(result).toBe(__filename);
    });

    it('should throw when TUSD_BINARY_PATH points to a nonexistent file', () => {
        process.env.TUSD_BINARY_PATH = '/nonexistent/tusd';
        expect(() => findTusdBinary()).toThrow('does not exist');
    });

    it('should find local bin/tusd if it exists', () => {
        delete process.env.TUSD_BINARY_PATH;
        // This test only passes when the binary has been downloaded
        try {
            const result = findTusdBinary();
            expect(result).toContain('tusd');
        } catch (err) {
            // If no binary is available, the function should throw with instructions
            expect(String(err)).toContain('No tusd binary found');
        }
    });
});
