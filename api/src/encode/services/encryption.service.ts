import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import { readdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join, relative } from 'path';
import {
    buildMediaPlaylist,
    getMediaPlaylistLayout,
    parseMediaPlaylist,
    setMediaPlaylistLayout,
    type HlsKey,
    type HlsMediaLayoutItem,
} from '@luminary-media-converter/hls';
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
        const playlists = await this.findPlaylistFiles(outputDir);
        await Promise.all(
            playlists.map((p) => this.injectKeyTag(p, keyUrl, iv))
        );
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

    /**
     * Arm the playlist with the session key.
     *
     * The key goes immediately before the first segment — after the header
     * `#EXT-X-MAP`, which per RFC 8216 §4.3.2.4 leaves that init plaintext, as
     * it is on disk (the pipeline never encrypts inits).
     *
     * A spliced smart-cut playlist carries further MAPs mid-list, and a key
     * tag governs every MAP that *follows* it — left alone, a conforming
     * player would try to decrypt those plaintext inits and feed the decoder
     * noise. So every mid-list MAP is fenced: `METHOD=NONE` before it,
     * the session key re-armed after it, before the part's first segment.
     */
    private async injectKeyTag(
        filePath: string,
        keyUrl: string,
        iv: Buffer
    ): Promise<void> {
        const content = await readFile(filePath, 'utf-8');
        const playlist = parseMediaPlaylist(content);
        // A master (no segments) is skipped; a playlist that already carries
        // a key was armed by an earlier pass — re-arming would double-fence.
        if (playlist.segments.length === 0) return;
        if (playlist.keys.length > 0) return;

        const sessionKey = (): HlsKey => ({
            method: 'AES-128',
            uri: keyUrl,
            iv: `0x${iv.toString('hex')}`,
        });
        const segmentSet = new Set<object>(playlist.segments);
        const mapSet = new Set<object>(playlist.maps);

        const layout = getMediaPlaylistLayout(playlist) ?? [];
        const next: HlsMediaLayoutItem[] = [];
        const keys: HlsKey[] = [];
        let armed = false;

        for (const item of layout) {
            const modeled = typeof item !== 'string';
            if (!armed && modeled && segmentSet.has(item)) {
                const key = sessionKey();
                keys.push(key);
                next.push(key);
                armed = true;
            } else if (armed && modeled && mapSet.has(item)) {
                const none: HlsKey = { method: 'NONE' };
                const rearm = sessionKey();
                keys.push(none, rearm);
                next.push(none, item, rearm);
                continue;
            }
            next.push(item);
        }
        if (!armed) return;

        playlist.keys = keys;
        setMediaPlaylistLayout(playlist, next);
        await writeFile(filePath, buildMediaPlaylist(playlist), 'utf-8');
    }
}
