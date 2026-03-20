import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CryptoService } from './crypto.service.js';

const TEST_KEY = 'a'.repeat(64); // 32 bytes of 0xaa

describe('CryptoService', () => {
    let service: CryptoService;

    beforeEach(() => {
        process.env.S3_ENCRYPTION_KEY = TEST_KEY;
        service = new CryptoService();
    });

    afterEach(() => {
        delete process.env.S3_ENCRYPTION_KEY;
    });

    it('should throw if S3_ENCRYPTION_KEY is missing', () => {
        delete process.env.S3_ENCRYPTION_KEY;
        expect(() => new CryptoService()).toThrow('S3_ENCRYPTION_KEY');
    });

    it('should throw if S3_ENCRYPTION_KEY is wrong length', () => {
        process.env.S3_ENCRYPTION_KEY = 'abcd';
        expect(() => new CryptoService()).toThrow('64-character hex string');
    });

    it('should encrypt and decrypt a string', () => {
        const plaintext = 'my-secret-access-key';
        const encrypted = service.encrypt(plaintext);
        expect(encrypted.iv).toBeDefined();
        expect(encrypted.tag).toBeDefined();
        expect(encrypted.ciphertext).toBeDefined();
        expect(encrypted.ciphertext).not.toBe(plaintext);

        const decrypted = service.decrypt(encrypted);
        expect(decrypted).toBe(plaintext);
    });

    it('should produce different IVs for the same plaintext', () => {
        const a = service.encrypt('same');
        const b = service.encrypt('same');
        expect(a.iv).not.toBe(b.iv);
        expect(a.ciphertext).not.toBe(b.ciphertext);
    });

    it('should handle empty string', () => {
        const encrypted = service.encrypt('');
        expect(service.decrypt(encrypted)).toBe('');
    });

    it('should handle unicode strings', () => {
        const plaintext = 'key/with/special chars & unicode: \u00e9\u00e8\u00ea';
        const encrypted = service.encrypt(plaintext);
        expect(service.decrypt(encrypted)).toBe(plaintext);
    });

    it('should fail to decrypt with tampered ciphertext', () => {
        const encrypted = service.encrypt('secret');
        encrypted.ciphertext = 'ff' + encrypted.ciphertext.slice(2);
        expect(() => service.decrypt(encrypted)).toThrow();
    });

    it('should fail to decrypt with tampered tag', () => {
        const encrypted = service.encrypt('secret');
        encrypted.tag = '00'.repeat(16);
        expect(() => service.decrypt(encrypted)).toThrow();
    });
});
