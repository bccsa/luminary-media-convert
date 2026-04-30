import { parentPort, workerData } from 'worker_threads';
import { createCipheriv, createHmac, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import {
    readdir,
    readFile,
    writeFile,
    rename,
    unlink,
    stat,
} from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join } from 'path';

interface WorkerData {
    outputDir: string;
    sessionId: string;
    keyUrl: string;
    seed: string;
    salt?: string;
}

const CONCURRENCY_LIMIT = 6;

function deriveKey(seed: string, sessionId: string, saltHex?: string): Buffer {
    const salt = saltHex ? Buffer.from(saltHex, 'hex') : undefined;
    const input = salt
        ? Buffer.concat([Buffer.from(sessionId), salt])
        : Buffer.from(sessionId);
    return createHmac('sha256', seed)
        .update(input)
        .digest()
        .subarray(0, 16);
}

async function mapWithLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const i = index++;
            results[i] = await fn(items[i]);
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => worker())
    );
    return results;
}

async function encryptSegmentFile(
    filePath: string,
    key: Buffer,
    iv: Buffer
): Promise<void> {
    const tmpPath = filePath + '.enc.tmp';
    try {
        const cipher = createCipheriv('aes-128-cbc', key, iv);
        await pipeline(
            createReadStream(filePath),
            cipher,
            createWriteStream(tmpPath)
        );
        await rename(tmpPath, filePath);
    } catch (err) {
        await unlink(tmpPath).catch(() => {});
        throw err;
    }
}

async function findPlaylistFiles(dir: string): Promise<string[]> {
    const playlists: string[] = [];
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
            playlists.push(...(await findPlaylistFiles(fullPath)));
        } else if (entry.name.endsWith('.m3u8')) {
            playlists.push(fullPath);
        }
    }
    return playlists;
}

async function injectKeyTag(
    filePath: string,
    keyTag: string
): Promise<boolean> {
    const content = await readFile(filePath, 'utf-8');
    if (!content.includes('#EXTINF:')) return false;

    const lines = content.split('\n');
    const result: string[] = [];
    let keyInserted = false;

    for (const line of lines) {
        if (!keyInserted && line.startsWith('#EXTINF:')) {
            result.push(keyTag);
            keyInserted = true;
        }
        result.push(line);
    }

    if (keyInserted) {
        await writeFile(filePath, result.join('\n'), 'utf-8');
    }
    return keyInserted;
}

(async () => {
    const { outputDir, sessionId, keyUrl, seed, salt } = workerData as WorkerData;

    const key = deriveKey(seed, sessionId, salt);
    const iv = randomBytes(16);

    const entries = await readdir(outputDir, { withFileTypes: true });
    const streamDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('stream_'))
        .map((e) => e.name)
        .sort();

    // Collect all segment files across all stream dirs
    const segmentFiles: string[] = [];
    for (const dir of streamDirs) {
        const dirPath = join(outputDir, dir);
        const files = await readdir(dirPath);
        for (const file of files) {
            if (
                !(file.endsWith('.m4s') || file.endsWith('.ts')) ||
                file === 'init.mp4'
            )
                continue;
            const filePath = join(dirPath, file);
            const s = await stat(filePath);
            if (s.isFile()) segmentFiles.push(filePath);
        }
    }

    // Encrypt segments concurrently, reporting progress
    let encryptedCount = 0;
    const totalSegments = segmentFiles.length;
    await mapWithLimit(segmentFiles, CONCURRENCY_LIMIT, async (filePath) => {
        await encryptSegmentFile(filePath, key, iv);
        encryptedCount++;
        const percent = Math.round((encryptedCount / totalSegments) * 100);
        parentPort!.postMessage({ type: 'progress', percent });
    });

    // Inject key tags into playlists
    const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x${iv.toString('hex')}`;
    const playlists = await findPlaylistFiles(outputDir);
    await Promise.all(playlists.map((p) => injectKeyTag(p, keyTag)));

    parentPort!.postMessage({
        type: 'done',
        key: Array.from(key),
        iv: Array.from(iv),
        segmentsEncrypted: segmentFiles.length,
        streamDirCount: streamDirs.length,
    });
})().catch((err) => {
    throw err;
});
