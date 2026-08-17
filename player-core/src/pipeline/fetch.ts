/**
 * Fetching text assets that may be LMCENC-encrypted.
 *
 * One choke point for every playlist and every VTT the wrapper reads, so the
 * encryption story is uniform and the failure modes are typed.
 */

import {
    isEncryptedPayload,
    isPlaylistText,
    isVttText,
} from '@luminary-media-converter/hls';
import type { PlayerError } from '../types.js';
import { decryptLmcenc, type SubtleLike } from './decrypt.js';

/** What the caller expects the decoded bytes to be. */
export type ExpectedAsset = 'playlist' | 'vtt' | 'any';

/** A typed pipeline failure, convertible to a {@link PlayerError}. */
export class PipelineError extends Error {
    readonly code: PlayerError['code'];
    readonly fatal: boolean;
    /**
     * True for HTTP 404 and 403 — S3 answers 403 for a missing key when the
     * caller has no list permission, so both mean "not published (yet)". The
     * coming-soon poller keys off this.
     */
    readonly missing: boolean;
    readonly url?: string;

    constructor(
        code: PlayerError['code'],
        message: string,
        options: { cause?: unknown; missing?: boolean; url?: string } = {},
    ) {
        super(message);
        this.name = 'PipelineError';
        this.code = code;
        this.fatal = true;
        this.missing = options.missing ?? false;
        this.url = options.url;
        if (options.cause !== undefined) this.cause = options.cause;
    }

    toPlayerError(): PlayerError {
        return {
            code: this.code,
            fatal: this.fatal,
            message: this.message,
            cause: this.cause,
        };
    }
}

/** True when `error` means "the resource is not there (yet)". */
export function isMissing(error: unknown): boolean {
    return error instanceof PipelineError && error.missing;
}

/** Normalize any thrown value into a presentable {@link PlayerError}. */
export function toPlayerError(error: unknown): PlayerError {
    if (error instanceof PipelineError) return error.toPlayerError();
    return {
        code: 'unknown',
        fatal: true,
        message: error instanceof Error ? error.message : String(error),
        cause: error,
    };
}

export interface FetchOptions {
    fetchImpl: typeof fetch;
    /** Session key; required to read LMCENC payloads. */
    keyHex?: string;
    /** Content check applied after decoding. Default `'any'`. */
    expect?: ExpectedAsset;
    signal?: AbortSignal;
    /** Injectable for tests; defaults to `globalThis.crypto.subtle`. */
    subtle?: SubtleLike;
}

/** A decoded text asset. */
export interface DecodedAsset {
    /** Absolute URL it was read from. */
    url: string;
    text: string;
    /** True when the response body was LMCENC and had to be decrypted. */
    wasEncrypted: boolean;
}

/** Raw bytes of a URL, with 404/403 surfaced as `missing`. */
export async function fetchBytes(
    url: string,
    options: Pick<FetchOptions, 'fetchImpl' | 'signal'>,
): Promise<Uint8Array> {
    let response: Response;
    try {
        response = await options.fetchImpl(url, { signal: options.signal });
    } catch (cause) {
        throw new PipelineError('fetch-failed', `Could not fetch ${url}`, {
            cause,
            url,
        });
    }

    if (!response.ok) {
        const missing = response.status === 404 || response.status === 403;
        throw new PipelineError(
            'fetch-failed',
            `HTTP ${response.status} for ${url}`,
            { missing, url },
        );
    }

    return new Uint8Array(await response.arrayBuffer());
}

/** Decode already-fetched bytes. Exposed for tests and for byte-level probes. */
export async function decodeMaybeEncrypted(
    bytes: Uint8Array,
    url: string,
    options: Omit<FetchOptions, 'fetchImpl' | 'signal'>,
): Promise<DecodedAsset> {
    const expect = options.expect ?? 'any';

    if (isEncryptedPayload(bytes)) {
        if (!options.keyHex) {
            throw new PipelineError(
                'key-required',
                `${url} is LMCENC-encrypted but no session key was supplied`,
                { url },
            );
        }
        let plain: Uint8Array;
        try {
            plain = await decryptLmcenc(bytes, options.keyHex, options.subtle);
        } catch (cause) {
            throw new PipelineError(
                'decrypt-failed',
                `Could not decrypt ${url}`,
                { cause, url },
            );
        }
        if (!matchesExpectation(plain, expect)) {
            // Padding happened to validate but the plaintext is nonsense —
            // almost always the wrong key.
            throw new PipelineError(
                'decrypt-failed',
                `Decrypted ${url} is not a ${expect === 'vtt' ? 'WebVTT file' : 'playlist'}`,
                { url },
            );
        }
        return { url, text: decodeUtf8(plain), wasEncrypted: true };
    }

    if (!matchesExpectation(bytes, expect)) {
        // Say what arrived, not only that it was wrong: the URL alone cannot
        // distinguish an error page, an empty body, and a stale cache entry,
        // and each of those is a different bug.
        const head = Array.from(bytes.subarray(0, 48))
            .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`))
            .join('');
        throw new PipelineError(
            'invalid-content',
            `${url} is neither LMCENC nor a recognizable ${expect === 'vtt' ? 'WebVTT file' : 'playlist'} ` +
                `(${bytes.length} bytes, starts: "${head}")`,
            { url },
        );
    }

    return { url, text: decodeUtf8(bytes), wasEncrypted: false };
}

/**
 * Fetch a text asset, transparently decrypting LMCENC payloads.
 *
 * Failure modes map straight onto {@link PlayerError} codes:
 * `fetch-failed` (transport / non-2xx, `missing` for 404+403),
 * `key-required` (LMCENC with no key), `decrypt-failed` (wrong key),
 * `invalid-content` (neither LMCENC nor the expected plaintext).
 */
export async function fetchMaybeEncrypted(
    url: string,
    options: FetchOptions,
): Promise<DecodedAsset> {
    const bytes = await fetchBytes(url, options);
    return decodeMaybeEncrypted(bytes, url, options);
}

function matchesExpectation(bytes: Uint8Array, expect: ExpectedAsset): boolean {
    if (expect === 'playlist') return isPlaylistText(bytes);
    if (expect === 'vtt') return isVttText(bytes);
    return isPlaylistText(bytes) || isVttText(bytes);
}

function decodeUtf8(bytes: Uint8Array): string {
    return new TextDecoder('utf-8').decode(bytes);
}
