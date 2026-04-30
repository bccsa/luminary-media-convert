import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolves the path to the tusd binary.
 *
 * Resolution order:
 * 1. TUSD_BINARY_PATH environment variable
 * 2. Local bin/tusd relative to the package root
 */
export function findTusdBinary(): string {
    // 1. Environment variable override
    const envPath = process.env.TUSD_BINARY_PATH;
    if (envPath) {
        if (!existsSync(envPath)) {
            throw new Error(
                `TUSD_BINARY_PATH is set to "${envPath}" but the file does not exist`,
            );
        }
        return envPath;
    }

    // 2. Local bin/tusd (relative to package root — one level up from dist/ or src/)
    const packageRoot = join(__dirname, '..');
    const localBin = join(packageRoot, 'bin', 'tusd');
    if (existsSync(localBin)) {
        return localBin;
    }

    throw new Error(
        `No tusd binary found. Either:\n` +
            `  - Set TUSD_BINARY_PATH environment variable\n` +
            `  - Run "npm -w tusd run download-tusd" to download tusd`,
    );
}
