import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join, relative } from 'path';
import { encryptTextAsset, isLmcencPayload } from './lmcenc.js';

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

    async injectKeyTagsIntoPlaylists(
        outputDir: string,
        keyUrl: string,
        iv: Buffer
    ): Promise<void> {
        const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x${iv.toString('hex')}`;
        const playlists = await this.findPlaylistFiles(outputDir);
        await Promise.all(playlists.map((p) => this.injectKeyTag(p, keyTag)));
        this.logger.log(
            `Injected key tags into ${playlists.length} playlist(s)`
        );
    }

    /**
     * Encrypt every playlist and WebVTT sidecar under `outputDir` in place.
     *
     * The last thing that happens to the output before it is uploaded: the
     * files are replaced by their LMCENC01 wrappers under the same names, so
     * S3 keys, extensions and playlist references are all unchanged. Anything
     * that still needs to *read* a playlist — key-tag injection, byte-range
     * rewriting, thumbnail VTT generation — must already have run, because
     * from here on the files are ciphertext.
     *
     * Each file gets its own IV. Files that already carry the magic are left
     * alone, so a re-run (a retry, a partially-completed pass) cannot
     * double-encrypt and strand the output.
     *
     * Returns the encrypted paths, relative to `outputDir`.
     */
    async encryptTextAssets(outputDir: string, key: Buffer): Promise<string[]> {
        const files = await this.findTextAssetFiles(outputDir);
        const encrypted: string[] = [];

        for (const filePath of files) {
            const content = await readFile(filePath);
            if (isLmcencPayload(content)) continue;
            await writeFile(filePath, encryptTextAsset(content, key));
            encrypted.push(
                relative(outputDir, filePath).split(/[\\/]/).join('/')
            );
        }

        this.logger.log(
            `Encrypted ${encrypted.length} playlist/VTT file(s) with the session key`
        );
        return encrypted;
    }

    /** Every `.m3u8` and `.vtt` file under `dir`, recursively. */
    private async findTextAssetFiles(dir: string): Promise<string[]> {
        const found: string[] = [];
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
                found.push(...(await this.findTextAssetFiles(fullPath)));
            } else if (
                entry.name.endsWith('.m3u8') ||
                entry.name.endsWith('.vtt')
            ) {
                found.push(fullPath);
            }
        }
        return found;
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
        keyTag: string
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
