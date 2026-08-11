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

The five prefixes it points at (`BASE` at the top of `index.html`) are local MinIO outputs, not
fixtures in the repo — they are gigabytes of encoded media. Re-create them by encoding through the
API with the configurations named in each case, or repoint `BASE` and the prefixes at whatever you
already have.

## What the five cases are for

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
