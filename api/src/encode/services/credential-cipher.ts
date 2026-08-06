import type { Provider } from '@nestjs/common';

/**
 * Encrypts and decrypts short strings on behalf of the process.
 *
 * The API never implements this itself: there is nowhere on the machine it
 * could keep a key that would not sit next to the ciphertext it protects. The
 * embedding host supplies one — in the Electron app, a thin wrapper over
 * `safeStorage`, whose key lives in the OS keychain and is unlocked by the
 * logged-in user rather than by anything on disk.
 *
 * Implementations are expected to return text (base64 or similar), since what
 * comes back is written straight to a file.
 */
export interface CredentialCipher {
    encrypt(plaintext: string): string;
    decrypt(ciphertext: string): string;
}

/**
 * Injection token for the host-supplied cipher. Bound to `undefined` when the
 * API runs standalone, which is a supported mode — see
 * {@link createCredentialCipherProvider}.
 */
export const CREDENTIAL_CIPHER = Symbol('CREDENTIAL_CIPHER');

/**
 * Builds the provider for {@link CREDENTIAL_CIPHER}.
 *
 * With no argument the token resolves to `undefined`, which means "no safe
 * place to write credentials": S3 keys are then held in memory only and a
 * restart strands every session that still needed them. That is the right
 * trade for a standalone dev run and the wrong one for the shipped app, so the
 * host is expected to pass a cipher.
 */
export const createCredentialCipherProvider = (
    cipher?: CredentialCipher,
): Provider => ({
    provide: CREDENTIAL_CIPHER,
    useFactory: (): CredentialCipher | undefined => cipher,
});
