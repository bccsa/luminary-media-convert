import { Injectable, Logger } from '@nestjs/common';
import { createHmac, randomBytes } from 'crypto';
import { existsSync } from 'fs';
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
