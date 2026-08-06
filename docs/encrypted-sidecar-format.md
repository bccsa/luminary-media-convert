# LMCENC — encrypted playlist / WebVTT format (v1)

Sessions created with `encryption.encryptPlaylists: true` upload their HLS
playlists and WebVTT sidecars encrypted, so third-party players cannot read
the stream layout, chapter titles, or subtitles without the session key. The
segment files were already AES-128 encrypted; this extends coverage to the
text assets.

## Layout

| Bytes  | Content                                                        |
|--------|----------------------------------------------------------------|
| 0–7    | ASCII `LMCENC01` — magic (`LMCENC`) + format version (`01`)    |
| 8–23   | 16-byte random IV, freshly generated **per file**              |
| 24–…   | AES-128-CBC ciphertext (PKCS#7 padding) of the UTF-8 plaintext |

- **Key**: the session's AES-128 segment key (16 bytes). The same key
  decrypts segments, playlists, and VTTs.
- **Scope**: `master.m3u8`, every media playlist, and every `.vtt` sidecar
  (subtitles, chapters, thumbnails VTT) when the session flag is set.
- **Not covered** (accepted gap): thumbnail sprite images referenced by the
  thumbnails VTT remain plaintext JPEGs.

## Detection rules (consumer side)

Applied to the raw response bytes, in order:

1. Starts with `LMCENC01` → encrypted. If no key is available, fail with a
   typed `key-required` error (do **not** attempt heuristics).
2. Otherwise, after skipping an optional UTF-8 BOM: starts with `#EXTM3U` →
   plaintext playlist; starts with `WEBVTT` → plaintext WebVTT. Unencrypted
   files therefore keep working even when a key is configured.
3. Anything else → hard `invalid-content` error (commonly a CDN/S3 error
   body). Never feed unrecognized bytes to AES — surface the real problem.

## Storage / transport

- S3 object keys and file extensions are **unchanged**.
- Encrypted objects are uploaded with `Content-Type: application/octet-stream`
  (prevents charset transcoding or compression middleware corrupting the
  ciphertext). Plaintext playlists keep `application/vnd.apple.mpegurl`,
  plaintext VTTs keep `text/vtt`.
- No `Content-Encoding` is set.

## Reference implementations

- Detection constants/helpers: `hls/src/enc-format.ts` (isomorphic).
- Encryptor: `api/src/encode/services/encryption.service.ts` (node crypto),
  run as the **final** step before S3 upload — after key-tag injection,
  byte-range packing, and thumbnail VTT generation.
- Decryptor: `player-core/src/pipeline/decrypt.ts` (WebCrypto `AES-CBC`).

## Security note

This is access control against casual extraction, **not DRM**. Anyone who
holds the session key (any legitimate viewer's browser) can decrypt every
asset. The threat it addresses is unauthenticated third parties and generic
HLS tooling reading published outputs directly.
