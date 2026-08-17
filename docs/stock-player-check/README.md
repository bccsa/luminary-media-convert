# Stock-player compatibility harness

A one-page harness for answering a question this repo's own player cannot answer: **what does a
third-party HLS player do with our output?** `player-core` munges playlists, extracts angles,
normalises key URIs and decrypts LMCENC before hls.js ever sees anything. A Luminary client that
has not adopted it sees the raw bytes in S3, and this page shows what that looks like.

It loads hls.js with **default config** on purpose — no custom loader, no munging, no key
injection — plus a native `<video src>` button per case for Safari's built-in HLS.

## Running it

`hls.min.js` is not committed (it is a build artefact of a dependency). Copy it in, then serve the
directory — `file://` will not do, because hls.js fetches over XHR and MinIO's CORS grant is
origin-based:

```bash
cp node_modules/hls.js/dist/hls.min.js docs/stock-player-check/
(cd docs/stock-player-check && python3 -m http.server 8899 --bind 127.0.0.1)
open http://127.0.0.1:8899/
```

The prefixes it points at (`BASE` at the top of `index.html`) are local MinIO outputs, not
fixtures in the repo — they are gigabytes of encoded media. Re-create them by encoding through the
API with the configurations named in each case, or repoint `BASE` and the prefixes at whatever you
already have.

## What the first five cases are for

| # | Output | Answers |
|---|---|---|
| 1 | Plaintext, single angle | Baseline. If this fails, nothing below means anything |
| 2 | Plaintext, multi-angle | Does the client stay on one angle, or does its ABR cross between them? |
| 3 | Encrypted, playlists encrypted (default) | Confirms LMCENC output is unreadable to a stock client |
| 4 | Encrypted, `encryptPlaylists: false`, no `keyUrl` | Is the opt-out sufficient on its own? (No — `luminary://key` is unresolvable) |
| 5 | Encrypted, `encryptPlaylists: false` + real `keyUrl` | The only encrypted configuration a stock client can play |

**Case 5 is a test fixture, not a deployment pattern.** It requires the raw AES key to be fetchable
over HTTP, and in this harness that means a key file sitting in the same bucket as the content it
encrypts — which protects nothing. This encoder generates keys locally precisely so they never
leave the machine, and it has no key server. A client that cannot decrypt playlists should be sent
unencrypted output; a client with its own key delivery is what the opt-out exists for.

Findings from the last run are recorded in `Todo.md` §0a.

## Cases 6–9 — the quick-trim (smart cut) spike

Quick trim splices copied GOP spans and short re-encoded bridge parts into one playlist, joined by
`#EXT-X-DISCONTINUITY` with a per-part `#EXT-X-MAP`. Two questions have to be answered before any
encode code is written (plan phase 0.4), and neither can be answered by this repo's own player,
which munges playlists before hls.js sees them: **does the multi-MAP shape decode in a stock
player**, and **which of the two `#EXT-X-KEY`/`#EXT-X-MAP` orderings survives it** — a key tag
governs every MAP that follows it, so a spliced playlist either fences each mid-list MAP with
`METHOD=NONE` and re-arms after it (case 7, what `EncryptionService` emits today) or encrypts the
inits too and arms once before the first MAP (case 8). Case 6 is the plaintext baseline for both;
case 9 is a conditional A/B, because ffmpeg writes each part's fragment `tfdt` zero-based and
carries the part's real start time in the init's `elst` empty edit, so an audio playlist that
shares one MAP across parts is safe only for a player that ignores edit lists. The three
directories are hand-assembled from cut parts of the reference file by
`spike/build-spike.mjs`, and `spike/verify-spike.mjs` checks everything checkable offline
(playlist round-trip through the `hls` library, structure and EXTINF sums, the AES round-trip,
and an ffprobe decode of every part after decryption). Upload them next to the other prefixes and
run the page:

```bash
# mc (aliased 'local' -> http://127.0.0.1:9000)
mc cp --recursive <scratchpad>/spike/plain          local/ac-images/todo11-test/stock/spike/
mc cp --recursive <scratchpad>/spike/enc-none-rearm local/ac-images/todo11-test/stock/spike/
mc cp --recursive <scratchpad>/spike/enc-init       local/ac-images/todo11-test/stock/spike/

# or the aws CLI against the same endpoint
aws --endpoint-url http://127.0.0.1:9000 s3 cp --recursive \
    <scratchpad>/spike s3://ac-images/todo11-test/stock/spike \
    --exclude 'build/*' --exclude '*.mjs' --exclude 'key.hex'
```

Do not upload `spike/build/` (ffmpeg intermediates), `key.hex` (the key and IV in plaintext, for
debugging) or the two scripts. Each case directory already carries its own `key.bin`, which the
playlists reference as `../key.bin` — the same test-only arrangement case 5 uses, and no more of a
deployment pattern here than it is there.

**Pass/fail.** Case 6 playing all three parts with audio in sync across both joins is the
precondition for the whole quick-trim design; if it fails, multi-MAP splicing is not viable in
stock players and the feature ships precise-mode only. Given case 6, whichever of cases 7 and 8
plays identically selects the encryption scheme — `METHOD=NONE`/re-arm (case 7) wins a tie, since
it is authoring-only and leaves inits plaintext on disk. If both fail, encrypted sessions fall back
to precise trimming in v1 (plan locked decision 5) and the finding goes back to the user before
phase 1 starts. Case 9 is only worth running if case 6's audio is offset or silent: if it fixes
that, the planner must emit a MAP for every part rather than letting copy-split parts continue the
previous init. ffmpeg-as-HLS-client failing on these is expected and not a finding — its demuxer
mishandles mid-playlist MAP switches (plan locked decision 4).
