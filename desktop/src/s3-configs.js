/**
 * S3 connection profiles — the only state the desktop shell owns.
 *
 * Everything else about a session lives in the encoder, which persists it to
 * WORK_DIR and restores it at boot. These do not: they outlive any session, and
 * they hold the user's real S3 credentials.
 *
 * Those credentials go through Electron's safeStorage, which delegates to the
 * OS keychain — Keychain on macOS, DPAPI on Windows, libsecret/kwallet on Linux.
 * The bucket and endpoint stay in plaintext so the list is still readable (and
 * repairable) when encryption is unavailable; only the two secret fields are
 * wrapped.
 *
 * Two Linux realities are handled rather than assumed away:
 *   - isEncryptionAvailable() is false with no keyring installed
 *   - the backend can change between sessions, leaving old blobs undecryptable
 * In both cases the profile survives with its credentials marked missing, so
 * the user re-enters a password instead of losing the whole configuration.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SECRET_FIELDS = ['accessKey', 'secretKey'];

export class S3ConfigStore {
    #path;
    #safeStorage;
    #configs = [];

    /**
     * @param {string} filePath  JSON file under userData
     * @param {import('electron').SafeStorage} safeStorage
     */
    constructor(filePath, safeStorage) {
        this.#path = filePath;
        this.#safeStorage = safeStorage;
        this.#load();
    }

    #load() {
        if (!existsSync(this.#path)) return;
        try {
            const parsed = JSON.parse(readFileSync(this.#path, 'utf-8'));
            this.#configs = Array.isArray(parsed?.configs) ? parsed.configs : [];
        } catch {
            // A corrupt file must not take the app down with it. The user can
            // re-add profiles; they cannot recover from a shell that will not
            // start. The bad file is left in place for inspection.
            this.#configs = [];
        }
    }

    #save() {
        mkdirSync(dirname(this.#path), { recursive: true });
        // tmp + rename so a crash mid-write cannot truncate the file.
        const tmp = `${this.#path}.tmp`;
        writeFileSync(tmp, JSON.stringify({ configs: this.#configs }, null, 2), {
            mode: 0o600,
        });
        renameSync(tmp, this.#path);
    }

    #encrypt(plaintext) {
        if (!plaintext) return null;
        if (!this.#safeStorage.isEncryptionAvailable()) {
            // No keyring. Refusing outright would make the app unusable on a
            // bare Linux box, so this is recorded honestly rather than silently
            // written as plaintext under a name implying it is encrypted.
            return { plaintext };
        }
        return {
            cipher: this.#safeStorage.encryptString(plaintext).toString('base64'),
        };
    }

    #decrypt(stored) {
        if (!stored) return '';
        if (stored.plaintext !== undefined) return stored.plaintext;
        if (!stored.cipher) return '';
        try {
            return this.#safeStorage.decryptString(
                Buffer.from(stored.cipher, 'base64')
            );
        } catch {
            // Written under a keyring backend that is no longer there. The
            // profile stays; the credential has to be re-entered.
            return '';
        }
    }

    /** Non-secret view, for listings. */
    #toSummary(config) {
        const { accessKey, secretKey, ...rest } = config;
        return {
            ...rest,
            // Mirrors the hosted service, whose list masks rather than omits.
            accessKey: '***',
            secretKey: '***',
        };
    }

    list() {
        return this.#configs.map((c) => this.#toSummary(c));
    }

    /** Full profile including decrypted credentials. */
    get(id) {
        const config = this.#configs.find((c) => c.id === id);
        if (!config) return undefined;
        return {
            ...this.#toSummary(config),
            accessKey: this.#decrypt(config.accessKey),
            secretKey: this.#decrypt(config.secretKey),
        };
    }

    create(input) {
        const config = {
            id: randomUUID(),
            name: input.name,
            endPoint: input.endPoint,
            port: input.port,
            useSSL: input.useSSL ?? true,
            bucket: input.bucket,
            region: input.region,
            publicUrl: input.publicUrl,
            accessKey: this.#encrypt(input.accessKey),
            secretKey: this.#encrypt(input.secretKey),
            createdAt: new Date().toISOString(),
        };
        this.#configs.push(config);
        this.#save();
        return this.#toSummary(config);
    }

    update(id, patch) {
        const config = this.#configs.find((c) => c.id === id);
        if (!config) return undefined;

        for (const [key, value] of Object.entries(patch)) {
            if (value === undefined) continue;
            if (SECRET_FIELDS.includes(key)) {
                // Blank means "leave it alone" — the edit form deliberately
                // does not round-trip secrets back to the client, so an empty
                // field is "unchanged", not "clear it".
                if (value === '') continue;
                config[key] = this.#encrypt(value);
            } else {
                config[key] = value;
            }
        }

        this.#save();
        return this.#toSummary(config);
    }

    remove(id) {
        const before = this.#configs.length;
        this.#configs = this.#configs.filter((c) => c.id !== id);
        if (this.#configs.length === before) return false;
        this.#save();
        return true;
    }

    /** Credentials in the shape the encoder's S3 config expects. */
    toEncoderS3(id, pathPrefix) {
        const config = this.get(id);
        if (!config) return undefined;
        return {
            endPoint: config.endPoint,
            ...(config.port ? { port: config.port } : {}),
            useSSL: config.useSSL,
            bucket: config.bucket,
            ...(config.region ? { region: config.region } : {}),
            accessKey: config.accessKey,
            secretKey: config.secretKey,
            ...(pathPrefix ? { pathPrefix } : {}),
        };
    }
}
