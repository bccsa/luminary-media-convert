import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

export interface EncryptedField {
    iv: string;
    tag: string;
    ciphertext: string;
}

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

@Injectable()
export class CryptoService {
    private readonly logger = new Logger(CryptoService.name);
    private readonly key: Buffer;

    constructor() {
        const hex = process.env.S3_ENCRYPTION_KEY;
        if (!hex || hex.length !== 64) {
            throw new Error(
                'S3_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)',
            );
        }
        this.key = Buffer.from(hex, 'hex');
        this.logger.log('S3 credential encryption key loaded');
    }

    encrypt(plaintext: string): EncryptedField {
        const iv = randomBytes(IV_LENGTH);
        const cipher = createCipheriv(ALGORITHM, this.key, iv);
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        return {
            iv: iv.toString('hex'),
            tag: tag.toString('hex'),
            ciphertext: encrypted.toString('hex'),
        };
    }

    decrypt(field: EncryptedField): string {
        const decipher = createDecipheriv(
            ALGORITHM,
            this.key,
            Buffer.from(field.iv, 'hex'),
        );
        decipher.setAuthTag(Buffer.from(field.tag, 'hex'));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(field.ciphertext, 'hex')),
            decipher.final(),
        ]);
        return decrypted.toString('utf8');
    }
}
