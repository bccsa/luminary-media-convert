import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createHmac, randomBytes } from 'crypto';
import { createReadStream, createWriteStream, existsSync } from 'fs';
import {
    readdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from 'fs/promises';
import { pipeline } from 'stream/promises';
import { join } from 'path';
import { Worker } from 'worker_threads';
import dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class EncryptionService {
    private readonly logger = new Logger(EncryptionService.name);

    deriveKey(sessionId: string, salt?: Buffer): Buffer {
        const seed = process.env.HLS_ENCRYPTION_SEED;
        if (!seed) {
            throw new Error(
                'HLS_ENCRYPTION_SEED environment variable is required for HLS encryption',
            );
        }
        const input = salt
            ? Buffer.concat([Buffer.from(sessionId), salt])
            : Buffer.from(sessionId);
        return createHmac('sha256', seed)
            .update(input)
            .digest()
            .subarray(0, 16);
    }

    generateSalt(): Buffer {
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

    async encryptHlsOutput(
        outputDir: string,
        sessionId: string,
        keyUrl: string,
        onProgress?: (percent: number) => void,
    ): Promise<{ key: Buffer; iv: Buffer }> {
        const seed = process.env.HLS_ENCRYPTION_SEED;
        if (!seed) {
            throw new Error(
                'HLS_ENCRYPTION_SEED environment variable is required for HLS encryption',
            );
        }

        const salt = this.generateSalt();

        const tsPath = join(__dirname, 'encryption.worker.ts');
        const useTsWorker = existsSync(tsPath);
        const workerPath = useTsWorker
            ? tsPath
            : join(__dirname, 'encryption.worker.js');

        return new Promise<{ key: Buffer; iv: Buffer }>((resolve, reject) => {
            const worker = new Worker(workerPath, {
                workerData: { outputDir, sessionId, keyUrl, seed, salt: salt.toString('hex') },
                ...(useTsWorker
                    ? {
                          execArgv: [
                              '--require',
                              'ts-node/register',
                          ],
                      }
                    : {}),
            });

            worker.on('message', (msg) => {
                if (msg.type === 'progress') {
                    onProgress?.(msg.percent);
                    return;
                }

                const key = Buffer.from(msg.key);
                const iv = Buffer.from(msg.iv);

                this.logger.log(
                    `Encrypted ${msg.segmentsEncrypted} segment(s) across ${msg.streamDirCount} stream(s) for session ${sessionId} (IV: ${iv.toString('hex')})`,
                );

                resolve({ key, iv });
            });

            worker.on('error', (err) => {
                reject(
                    new Error(
                        `Encryption worker error: ${err.message}`,
                    ),
                );
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    reject(
                        new Error(
                            `Encryption worker exited with code ${code}`,
                        ),
                    );
                }
            });
        });
    }

}
