import { parentPort, workerData } from 'worker_threads';
import { createReadStream, createWriteStream } from 'fs';
import {
    readdir,
    readFile,
    writeFile,
    stat,
    unlink,
} from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join } from 'path';

interface WorkerData {
    outputDir: string;
    maxFileSizeBytes: number;
}

async function convertStreamToByteRange(
    streamDir: string,
    maxFileSizeBytes: number,
): Promise<void> {
    const playlistPath = join(streamDir, 'playlist.m3u8');
    let content: string;
    try {
        content = await readFile(playlistPath, 'utf-8');
    } catch {
        return;
    }

    const lines = content.split('\n');

    const headerLines: string[] = [];
    const segments: { extinfLine: string; filename: string }[] = [];
    let footerLine = '';
    let inSegments = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#EXTINF:')) {
            inSegments = true;
            const filename = lines[i + 1]?.trim();
            if (filename && !filename.startsWith('#')) {
                segments.push({ extinfLine: line, filename });
                i++;
            }
        } else if (line.startsWith('#EXT-X-ENDLIST')) {
            footerLine = line;
        } else if (!inSegments) {
            headerLines.push(line);
        }
    }

    if (segments.length === 0) return;

    const firstSeg = segments[0].filename;
    const segExt = firstSeg.endsWith('.m4s') ? 'm4s' : 'ts';

    // Get sizes for all segments upfront
    const segSizes = await Promise.all(
        segments.map(async (seg) => {
            const segPath = join(streamDir, seg.filename);
            try {
                const s = await stat(segPath);
                return s.size;
            } catch {
                return 0;
            }
        }),
    );

    const byteRanges: {
        extinfLine: string;
        length: number;
        offset: number;
        mediaFile: string;
    }[] = [];
    let fileIndex = 0;
    let currentOffset = 0;
    let currentMediaFile = `media_${fileIndex}.${segExt}`;
    let writeStream = createWriteStream(join(streamDir, currentMediaFile));
    writeStream.setMaxListeners(0);

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const segSize = segSizes[i];
        if (segSize === 0) continue;

        if (
            currentOffset > 0 &&
            currentOffset + segSize > maxFileSizeBytes
        ) {
            writeStream.end();
            await new Promise<void>((resolve) => writeStream.on('finish', resolve));
            fileIndex++;
            currentOffset = 0;
            currentMediaFile = `media_${fileIndex}.${segExt}`;
            writeStream = createWriteStream(
                join(streamDir, currentMediaFile),
            );
            writeStream.setMaxListeners(0);
        }

        const segPath = join(streamDir, seg.filename);
        await pipeline(createReadStream(segPath), writeStream, {
            end: false,
        });

        byteRanges.push({
            extinfLine: seg.extinfLine,
            length: segSize,
            offset: currentOffset,
            mediaFile: currentMediaFile,
        });
        currentOffset += segSize;
    }

    writeStream.end();
    await new Promise<void>((resolve) => writeStream.on('finish', resolve));

    // Rewrite playlist with byte-range entries
    const newLines: string[] = [...headerLines];
    for (const br of byteRanges) {
        newLines.push(br.extinfLine);
        newLines.push(`#EXT-X-BYTERANGE:${br.length}@${br.offset}`);
        newLines.push(br.mediaFile);
    }
    if (footerLine) newLines.push(footerLine);
    newLines.push('');

    await writeFile(playlistPath, newLines.join('\n'), 'utf-8');

    // Delete original segment files
    await Promise.all(
        segments.map((seg) =>
            unlink(join(streamDir, seg.filename)).catch(() => {}),
        ),
    );
}

(async () => {
    const { outputDir, maxFileSizeBytes } = workerData as WorkerData;

    const entries = await readdir(outputDir, { withFileTypes: true });
    const streamDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('stream_'))
        .map((e) => e.name)
        .sort();

    for (const dir of streamDirs) {
        await convertStreamToByteRange(
            join(outputDir, dir),
            maxFileSizeBytes,
        );
    }

    parentPort!.postMessage({ streamCount: streamDirs.length });
})().catch((err) => {
    throw err;
});
