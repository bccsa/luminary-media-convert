import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createHmac, randomBytes } from 'crypto';
import {
    existsSync,
    readdirSync,
    readFileSync,
    writeFileSync,
    statSync,
} from 'fs';
import { join } from 'path';
import { Worker } from 'worker_threads';
import dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class EncryptionService {
    private readonly logger = new Logger(EncryptionService.name);

    deriveKey(sessionId: string): Buffer {
        const seed = process.env.HLS_ENCRYPTION_SEED;
        if (!seed) {
            throw new Error(
                'HLS_ENCRYPTION_SEED environment variable is required for HLS encryption',
            );
        }
        return createHmac('sha256', seed)
            .update(sessionId)
            .digest()
            .subarray(0, 16);
    }

    generateIV(): Buffer {
        return randomBytes(16);
    }

    encryptSegment(data: Buffer, key: Buffer, iv: Buffer): Buffer {
        const cipher = createCipheriv('aes-128-cbc', key, iv);
        return Buffer.concat([cipher.update(data), cipher.final()]);
    }

    async encryptHlsOutput(
        outputDir: string,
        sessionId: string,
        keyUrl: string,
    ): Promise<{ key: Buffer; iv: Buffer }> {
        const seed = process.env.HLS_ENCRYPTION_SEED;
        if (!seed) {
            throw new Error(
                'HLS_ENCRYPTION_SEED environment variable is required for HLS encryption',
            );
        }

        const tsPath = join(__dirname, 'encryption.worker.ts');
        const useTsWorker = existsSync(tsPath);
        const workerPath = useTsWorker
            ? tsPath
            : join(__dirname, 'encryption.worker.js');

        return new Promise<{ key: Buffer; iv: Buffer }>((resolve, reject) => {
            const worker = new Worker(workerPath, {
                workerData: { outputDir, sessionId, keyUrl, seed },
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

    private encryptStreamDir(
        streamDir: string,
        key: Buffer,
        iv: Buffer,
    ): number {
        const files = readdirSync(streamDir);
        let count = 0;
        for (const file of files) {
            if (!(file.endsWith('.m4s') || file.endsWith('.ts')) || file === 'init.mp4') continue;
            const filePath = join(streamDir, file);
            const stat = statSync(filePath);
            if (!stat.isFile()) continue;

            const plaintext = readFileSync(filePath);
            const ciphertext = this.encryptSegment(plaintext, key, iv);
            writeFileSync(filePath, ciphertext);
            count++;
        }
        return count;
    }

    private injectKeyTags(
        outputDir: string,
        keyUrl: string,
        iv: Buffer,
    ): number {
        const keyTag = `#EXT-X-KEY:METHOD=AES-128,URI="${keyUrl}",IV=0x${iv.toString('hex')}`;
        let count = 0;

        const processDir = (dir: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const fullPath = join(dir, entry.name);
                if (entry.isDirectory()) {
                    processDir(fullPath);
                } else if (entry.name.endsWith('.m3u8')) {
                    const content = readFileSync(fullPath, 'utf-8');
                    if (!content.includes('#EXTINF:')) continue;

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
                        writeFileSync(fullPath, result.join('\n'), 'utf-8');
                        count++;
                    }
                }
            }
        };

        processDir(outputDir);
        return count;
    }
}
