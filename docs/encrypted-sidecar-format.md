# LMCENC — encrypted playlist / WebVTT format (v1)

An encrypted session encrypts its whole output, not just the media: the HLS
playlists and every WebVTT sidecar are wrapped too, so nothing without the
session key can read the stream layout, chapter titles, or subtitles. Asking
for an encrypted stream and publishing its table of contents beside it
protects very little, so this follows `encryption.enabled` — set
`encryption.encryptPlaylists: false` to opt out, for output that has to stay
readable by players which cannot decrypt playlists.

## Layout

| Bytes  | Content                                                        |
|--------|----------------------------------------------------------------|
| 0–7    | ASCII `LMCENC01` — magic (`LMCENC`) + format version (`01`)    |
| 8–23   | 16-byte random IV, freshly generated **per file**              |
| 24–…   | AES-128-CBC ciphertext (PKCS#7 padding) of the UTF-8 plaintext |

- **Key**: the session's AES-128 segment key (16 bytes). The same key
  decrypts segments, playlists, and VTTs.
- **Scope**: `master.m3u8`, every media playlist, and every `.vtt` sidecar
  (subtitles, chapters, thumbnails VTT). Sidecars written after the encode —
  chapters saved from the editor — are encrypted on write by the same rule,
  and decrypted on read, so the output stays internally consistent.
- **Not covered** (accepted gaps, decided rather than overlooked):
  - Thumbnail sprite images referenced by the thumbnails VTT remain plaintext
    JPEGs.
  - `init_*.mp4`, the fMP4 initialisation segment of each stream, remains
    plaintext. HLS
    AES-128 does not cover it, and encrypting it would break every standard
    player in order to hide a codec string, a resolution and a timescale.
  - `waveform.json` beside the master remains plaintext (Ivan, 12 Aug 2026). It
    is a loudness curve: it shows where speech and silence fall and roughly how
    long things run, and carries no words, images or identities. The sprites in
    the line above leak far more — actual frames — so encrypting the quieter
    artefact while the louder one stays readable would be theatre. Keeping it
    plaintext also keeps `POST /api/hls/waveform/read` stateless, which is how it
    is designed: inline S3 credentials, a prefix, and no session key.

  Both are derived artefacts rather than playlists or text tracks, which is the
  line this scope draws. If the sprites are ever encrypted, the waveform should
  go with them — one answer for the class, not two.

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
