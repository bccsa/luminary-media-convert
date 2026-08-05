import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { S3ConfigStore } from './s3-configs.js';

/** Stands in for the OS keychain. */
function fakeSafeStorage({ available = true } = {}) {
    return {
        isEncryptionAvailable: () => available,
        encryptString: (s) => Buffer.from(`enc:${s}`),
        decryptString: (buf) => {
            const text = buf.toString();
            if (!text.startsWith('enc:')) throw new Error('wrong backend');
            return text.slice(4);
        },
    };
}

const PROFILE = {
    name: 'Local MinIO',
    endPoint: '127.0.0.1',
    port: 9100,
    useSSL: false,
    bucket: 'media',
    region: 'auto',
    publicUrl: 'https://cdn.example.test',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'sh-secret',
};

describe('S3ConfigStore', () => {
    let dir;
    let store;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 's3-configs-'));
        store = new S3ConfigStore(join(dir, 's3.json'), fakeSafeStorage());
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    describe('publicView', () => {
        // The renderer builds every playback and storyboard URL from this. It
        // was missing at first, and the symptom was silent: encodes succeeded,
        // then the finished session had no video and no thumbnails, because the
        // page could not construct a single object URL.
        it('carries what a public object URL is built from', () => {
            const { id } = store.create(PROFILE);
            expect(store.publicView(id)).toMatchObject({
                endPoint: '127.0.0.1',
                port: 9100,
                useSSL: false,
                bucket: 'media',
                publicUrl: 'https://cdn.example.test',
            });
        });

        it('includes the session prefix when given one', () => {
            const { id } = store.create(PROFILE);
            expect(store.publicView(id, 'projects/one').pathPrefix).toBe(
                'projects/one'
            );
        });

        it.each(['accessKey', 'secretKey'])('omits %s entirely', (field) => {
            const { id } = store.create(PROFILE);
            // Absent rather than masked: nothing to leak if this is logged.
            expect(store.publicView(id)).not.toHaveProperty(field);
        });

        it('is undefined for a profile that no longer exists', () => {
            expect(store.publicView('gone')).toBeUndefined();
        });
    });

    describe('credentials at rest', () => {
        it('never writes a secret to disk in the clear', () => {
            store.create(PROFILE);
            const onDisk = readFileSync(join(dir, 's3.json'), 'utf-8');
            expect(onDisk).not.toContain('sh-secret');
            expect(onDisk).not.toContain('AKIAEXAMPLE');
        });

        it('returns them decrypted on detail', () => {
            const { id } = store.create(PROFILE);
            expect(store.get(id)).toMatchObject({
                accessKey: 'AKIAEXAMPLE',
                secretKey: 'sh-secret',
            });
        });

        it('masks them in listings', () => {
            store.create(PROFILE);
            expect(store.list()[0]).toMatchObject({
                accessKey: '***',
                secretKey: '***',
            });
        });

        it('hands the encoder real credentials plus the prefix', () => {
            const { id } = store.create(PROFILE);
            expect(store.toEncoderS3(id, 'projects/one')).toMatchObject({
                bucket: 'media',
                accessKey: 'AKIAEXAMPLE',
                secretKey: 'sh-secret',
                pathPrefix: 'projects/one',
            });
        });
    });

    describe('when the keychain is unavailable', () => {
        // Linux without libsecret. Refusing outright would make the app
        // unusable there, so this is recorded honestly rather than written
        // under a name implying it is encrypted.
        it('still stores and returns the credential', () => {
            const plain = new S3ConfigStore(
                join(dir, 'plain.json'),
                fakeSafeStorage({ available: false })
            );
            const { id } = plain.create(PROFILE);
            expect(plain.get(id).secretKey).toBe('sh-secret');
        });
    });

    describe('when the keychain backend changed', () => {
        it('keeps the profile and blanks only the unreadable credential', () => {
            const { id } = store.create(PROFILE);

            // Reopened against a backend that cannot read the old blob.
            const reopened = new S3ConfigStore(join(dir, 's3.json'), {
                isEncryptionAvailable: () => true,
                encryptString: (s) => Buffer.from(`v2:${s}`),
                decryptString: () => {
                    throw new Error('cannot decrypt');
                },
            });

            const config = reopened.get(id);
            // The profile survives: the user re-enters a password rather than
            // losing the endpoint, bucket and everything else with it.
            expect(config.bucket).toBe('media');
            expect(config.secretKey).toBe('');
        });
    });

    describe('updating', () => {
        it('leaves a secret alone when the field is submitted empty', () => {
            const { id } = store.create(PROFILE);
            // The edit form does not round-trip secrets, so blank means
            // "unchanged" rather than "clear it".
            store.update(id, { bucket: 'other', secretKey: '' });
            expect(store.get(id)).toMatchObject({
                bucket: 'other',
                secretKey: 'sh-secret',
            });
        });

        it('replaces a secret when a new one is given', () => {
            const { id } = store.create(PROFILE);
            store.update(id, { secretKey: 'rotated' });
            expect(store.get(id).secretKey).toBe('rotated');
        });
    });
});
