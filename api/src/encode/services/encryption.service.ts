import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join } from 'path';

@Injectable()
export class EncryptionService {
    private readonly logger = new Logger(EncryptionService.name);

    /**
     * A fresh AES-128 key per encode. Nothing derives it from a shared secret,
     * so a leaked key compromises exactly one session's output.
     */
    generateKey(): Buffer {
        return randomBytes(16);
    }

    generateIV(): Buffer {
        return randomBytes(16);
    }

    async encryptSegment(
        filePath: string,
        key: Buffer,
        iv: Buffer,
    ): Promise<void> {
        const tmpPath = filePath + '.enc.tmp';
        try {
            const cipher = createCipheriv('aes-128-cbc', key, iv);
            await pipeline(
                createReadStream(filePath),
                cipher,
                createWriteStream(tmpPath),
            );
            await rename(tmpPath, filePath);
        } catch (err) {
            await unlink(tmpPath).catch(() => {});
            throw err;
        }
    }

    async injectKeyTagsIntoPlaylists(
        outputDir: string,
        keyUrl: string,
        iv: Buffer,
    ): Promise<void> {
        const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x${iv.toString('hex')}`;
        const playlists = await this.findPlaylistFiles(outputDir);
        await Promise.all(
            playlists.map((p) => this.injectKeyTag(p, keyTag)),
        );
        this.logger.log(
            `Injected key tags into ${playlists.length} playlist(s)`,
        );
    }

    private async findPlaylistFiles(dir: string): Promise<string[]> {
        const playlists: string[] = [];
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                playlists.push(...(await this.findPlaylistFiles(fullPath)));
            } else if (entry.name.endsWith('.m3u8')) {
                playlists.push(fullPath);
            }
        }
        return playlists;
    }

    private async injectKeyTag(
        filePath: string,
        keyTag: string,
    ): Promise<void> {
        const content = await readFile(filePath, 'utf-8');
        if (!content.includes('#EXTINF:')) return;

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
    }
}
