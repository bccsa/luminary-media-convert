import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createHmac, randomBytes } from 'crypto';
import {
    readdirSync,
    readFileSync,
    writeFileSync,
    statSync,
} from 'fs';
import { join } from 'path';
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

    encryptHlsOutput(
        outputDir: string,
        sessionId: string,
        keyUrl: string,
    ): { key: Buffer; iv: Buffer } {
        const key = this.deriveKey(sessionId);
        const iv = this.generateIV();

        const entries = readdirSync(outputDir, { withFileTypes: true });
        const streamDirs = entries
            .filter(e => e.isDirectory() && e.name.startsWith('stream_'))
            .map(e => e.name)
            .sort();

        let segmentsEncrypted = 0;
        for (const dir of streamDirs) {
            segmentsEncrypted += this.encryptStreamDir(
                join(outputDir, dir),
                key,
                iv,
            );
        }

        this.logger.log(
            `Encrypted ${segmentsEncrypted} segment(s) across ${streamDirs.length} stream(s) for session ${sessionId} (IV: ${iv.toString('hex')})`,
        );

        const playlistsRewritten = this.injectKeyTags(outputDir, keyUrl, iv);
        this.logger.log(
            `Injected #EXT-X-KEY into ${playlistsRewritten} playlist(s) for session ${sessionId}`,
        );

        return { key, iv };
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
