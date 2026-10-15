# Suspension-safe playback — cross-implementation spec

Written for whoever builds the AVPlayer or ExoPlayer adapter. It says which
parts of playback this repository's JavaScript owns, which parts your platform
must own, and why the line falls where it does.

## The problem in one paragraph

On the web the player is JavaScript all the way down: `player-core` munges
playlists, `VideoJsAdapter` drives Video.js, and VHS itself is JavaScript. When
the runtime stalls — a backgrounded tab, a locked screen — all three stop
together, so nothing is ever waiting on a callback that will not come. A native
engine breaks that symmetry. AVPlayer and ExoPlayer keep pulling segments from
their own threads while the WebView is frozen, which turns every JavaScript
callback they depend on into a liveness dependency, and a locked phone into the
exact condition under which those dependencies fail.

So the dividing line is not "shared code versus platform code". It is **what
must keep working while JavaScript is frozen**. Anything in that set lives
beside the engine, in your language, even when that means implementing it twice.

## The rule

> **The engine detects. The wrapper re-munges.**

Every engine watches its own buffer better than a wrapper could: VHS's
`PlaybackWatcher` samples at 250 ms against buffered ranges, hls.js has its gap
controller, AVPlayer posts stall notifications, ExoPlayer has a load-error
policy. Detection is therefore yours, and so is recovery.

The one repair no engine can perform is **rebuilding a munged source**. What the
engine is playing is not what is in the bucket: angles have been narrowed to
one, renditions above the quality cap removed, LMCENC decrypted, key URIs
rewritten to `luminary://key`. Only `player-core` knows how to produce that, so
it is the only thing you call back for.

### What still runs in JavaScript during playback

Three things, each deliberate, each harmless:

| | Why it is safe |
|---|---|
| The re-munge (`reload-requested`) | Unavoidable — only the wrapper knows what the source was munged from — and deferred: your ladder stops at `reattach()` while suspended and raises the request on resume |
| Coming-soon polling | Nothing is playing while it runs. Suspension costs latency, not correctness: a locked phone picks the stream up on wake |
| The state store | Frozen while suspended, corrected by the resume re-emit below. It drives a UI nobody is looking at |

Everything else on the playback path is either yours or resolved before
playback starts.

## Responsibilities

| Concern | Owner | Why there |
|---|---|---|
| Playlist munging: angles, quality cap, LMCENC decrypt, key rewriting | **`player-core`** | Load-time, once per attach. The result is plain text your serving layer holds from then on |
| Turning munged text into a loadable URL | **Your `ServeStrategy`** | Object URLs on the web; a loopback server or file URIs natively. A native player cannot read a `blob:` URL at all |
| AES-128 key delivery for `luminary://key` | **You** | Per segment, while frozen. A resource-loader delegate or `DataSource`, never a bridge call |
| Stall detection | **Your engine** | It sees its own buffer; a wrapper timer sees a frozen playhead and cannot tell a slow request from a wedged decoder |
| The recovery ladder | **You** (see below) | It must act during playback, which is when JavaScript may be gone |
| Chunk warming | **You** | A JS interval is throttled or suspended exactly when a native player keeps buffering. `docs/chunk-warming.md` |
| Rebuilding a munged source | **`player-core`** | Only it knows the recipe. Needs JavaScript, and is the only thing that does |
| Live playlist refresh | **Your serving layer** | Every target-duration, forever, while frozen. See *Live* below |
| Coming-soon polling, the state store | **`player-core`** | Nothing is playing |

## The recovery obligation

`PlayerAdapter` states it; this is the prose. Before you may emit `error` with
`fatal: true` — which the wrapper treats as the end of playback, with no retry
of its own — you must have climbed this ladder, tuned by the
`RecoveryPolicy` handed to you in `AdapterSource.recovery`:

1. **Your engine's in-place primitive, once.** hls.js `recoverMediaError()` /
   `startLoad()`, ExoPlayer `prepare()`. An engine with nothing to try skips the
   rung — report that honestly, because a repair you claim and did not make
   stops the ladder climbing.
2. **`reattach()`, bounded, with backoff.** Spaced by `reloadDelaysMs`, capped at
   `maxReloadAttempts`. This is the rung that matters while suspended, because
   it needs nothing from anyone else.
3. **`reload-requested`.** Ask the wrapper to rebuild the source, for the
   failures re-attaching cannot fix.

Then, and only then, `error`.

**If your engine already does rungs 1–2, use it.** ExoPlayer's
`LoadErrorHandlingPolicy` is precisely a retry-count-plus-backoff policy; wiring
ours alongside would be two ladders on one engine, fighting. AVPlayer has no
equivalent, so port the reference:
`player-web-legacy/src/drivers/RecoveryLadder.ts`. It is self-contained for
exactly this reason — it imports one *type* from `player-core` and nothing else.

### `reattach()`

Re-prepare the engine against the source you already hold. No munge, no wrapper,
no bridge.

The reason this is a separate call, rather than asking for a reload every time,
is worth stating because it is not obvious: **for an unchanged selection the
munge is deterministic.** Narrowing and capping are pure functions, the playlists
come back byte-identical, and the only thing a full reload produces that a
re-attach does not is a fresh set of URLs for the same text. All the value was
ever in the engine being rebuilt. Separating them is what lets a backgrounded
native player recover on its own, and reserves the re-munge for what genuinely
changes the source: an angle switch, a quality cap, a live refresh.

The wrapper now draws the same conclusion about URLs. A media playlist's served
form depends only on its text, its URL and the session key, so a source serves
each playlist once and every later munge of it — an angle switch, the audio
toggle, a re-munge — reuses that URL, serving only a new master. The fresh URLs
a re-munge used to mint were never revoked before the next load, and on a flaky
connection, where the ladder resets every time playback recovers, they
accumulated without bound.

An implementation MUST:

- Restore position and play state itself. The wrapper is not involved and may
  not even be running.
- Keep or re-arm whatever it attached to the source — text tracks, key delivery,
  the warming loop. The source has not changed, so neither have the chunk chains.
- No-op when nothing has been loaded yet.

On Video.js this is a re-`src()` of the same URL. Video.js ships a
`reloadSourceOnError` plugin that does the same mechanics (capture the position,
re-src, restore on `loadedmetadata`, play) and it is a fair reference for those
— but not an implementation to adopt, because it has no attempt cap and a
wall-clock interval, so it retries a permanent failure every thirty seconds for
as long as the page is open.

### Clocks

**Measure every window and backoff on a monotonic clock.**
`performance.now()` on the web, `CLOCK_MONOTONIC` on Apple platforms,
`SystemClock.elapsedRealtime()` on Android. Never wall-clock time.

A phone locked for forty minutes wakes with `Date.now()` forty minutes ahead. An
error that recurred the instant playback resumed then looks like a fresh one,
the escalation window judges it as unrelated, and the ladder restarts at rung 1
at exactly the moment it should be escalating. This was a real bug in the
wrapper's old ladder; it went with it.

### Resume

When your app returns to the foreground, **say again what is true now**:
re-emit `timeupdate`, `durationchange`, `progress` and the real transport state
(`playing` or `pause`).

Every field the wrapper publishes is pushed from an adapter event, so a
suspension leaves the playhead, the buffered band and the play state showing
whatever they showed when the screen locked. Re-emitting corrects the store
through the path it uses the rest of the time, which is why there is no pull API
for this moment and no new method to implement.

Also re-raise any `reload-requested` that went out while you were frozen: it
reached nobody, and it is not an attempt that failed. The reference ladder does
this in `noteResumed()`.

A WebView the OS reclaims outright needs nothing new. `PlayerSource.startPosition`
already exists, and the host persists what it was playing.

## Live

Live is the one place LMCENC decryption lands on the per-request path, and it is
therefore the sharpest form of everything above.

A live media playlist has no `#EXT-X-ENDLIST` and must be re-read every
`#EXT-X-TARGETDURATION` for as long as it plays. On an encrypted session each of
those reads is a fetch, an LMCENC decrypt and a rewrite. If any of that is
JavaScript, live playback stops when the screen locks — so **the whole refresh
loop belongs to your serving layer**.

`player-core` hands it everything needed to work alone, as plain data:

```ts
interface LivePlaylistSpec {
    url: string;          // the live media playlist, re-fetched every refreshSec
    baseUrl: string;      // what relative URIs in it resolve against
    keyUri?: string;      // what every AES-128 URI= is rewritten to; absent ⇒ no key
    keyBytes?: Uint8Array;// the session key, for LMCENC; absent ⇒ plaintext only
    refreshSec: number;   // #EXT-X-TARGETDURATION
}
```

Per engine request, behind the URL your `serveLive(spec)` returned:

```
fetch(url) → if (isEncryptedPayload) decryptLmcenc(keyBytes) → rewrite → serve
```

`resolveLivePlaylist(spec, { fetchImpl })` in `player-core` is exactly this, one
read per call, and is the reference to port. With no `keyUri` (no session key),
key lines are left alone and an AES-128 key appearing is a `key-required`
failure — the rule the load applied to the first read, applied to every read,
because a live stream can start encrypting part-way through.

There is no refresh timer in that picture, and there should not be one: the
engine already re-requests a live playlist on the cadence HLS prescribes, and
answering each request freshly *is* the refresh. `refreshSec` is for a serving
layer that cannot answer a request asynchronously and has to pre-fetch.

The rewrite is two edits — substitute `keyUri`, absolutize against `baseUrl` —
and that is why `rewriteMediaPlaylist` in `player-core` is string work rather
than a model round-trip: it is the function you are porting. A textual rewrite
is also strictly more preserving than parsing and rebuilding, since it does not
touch a line it does not recognise.

**Sniff for LMCENC, do not assume it.** Detection is by the eight-byte
`LMCENC01` magic, never by absence-sniffing. A plaintext third-party playlist
costs one comparison and passes through; a Luminary-wrapped one decrypts. One
code path covers both, so who produces the stream never has to be pinned down in
advance. Standard AES-128 with a real, fetchable `keyUrl` needs no resolver
involvement at all — the engine fetches those itself.

**Capability is declared by implementing the method.** A `ServeStrategy` with no
`serveLive` is VOD-only, and the pipeline refuses a live source with
`PlayerError{ code: 'live-unsupported' }` rather than serving a snapshot that
can never change — which would look like playback and not be. A boolean flag
could lie about this; a missing method cannot.

Nothing in this repository produces live output: `-hls_playlist_type vod` means
ffmpeg writes the playlist only at the end, which is why coming-soon polling
exists at all. Live sources are third-party streams.

**An address outlives its release.** The controller releases a source before
the next one is attached, and the engine it was given to keeps refreshing until
it is actually replaced. A request for a released address comes from that
engine and nothing else, so leave it unanswered until the engine abandons it;
failing it sends a live engine through its whole error handling - on VHS, one
excluded rendition after another - in the moments before it is discarded.

**The web implementation** is `player-web-legacy`: `BlobServeStrategy.serveLive`
registers the spec under a synthetic `luminary://live/<n>` (a blob URL cannot
change), and `vhsLivePlaylistInterceptor.ts` answers VHS's requests for that URI
on the same request seam the in-memory key uses, calling `resolveLivePlaylist`
each time. It pauses with the page, as VHS itself does — acceptable on the web,
and precisely what a native resolver must not do.

## A caution from the web implementation

Worth reading before you tune any timeout against this encoder's output, because
the same trap is set on every platform.

VHS issues every segment request with `timeout = targetDuration × 1.5` — 9 s at
this encoder's default 6 s segments — and on a timeout takes what it calls
emergency action: the video loader floors its bandwidth estimate and forces ABR
to the lowest rendition; the audio loader raises an error that excludes the
current video rendition or flips the audio track back to default. All of it
assumes a slow request means too little bandwidth *for this rendition*.

On byte-range output that assumption is false. Every rendition of an angle shares
one chunk object and every audio group shares another, so a slow request means
the edge is still backhauling a cold object — and "switching down" re-requests
*the same object* at a different offset, one the backhaul may not have reached.
Nine seconds of progress discarded, quality floored, the wait restarted.

The fix on the web is `player-web-legacy/src/adapter/vhsRequestTimeout.ts`:
requests carrying a `Range` header get a backstop of ten times the target
duration instead. If your platform has a per-request timeout with a
bandwidth-flavoured response, check it against a cold chunk before trusting it.

## Reference implementations

Everything a native adapter ports lives in `player-web-legacy/src`:

- **`drivers/RecoveryLadder.ts`** — the ladder, whole. The porting unit.
- **`drivers/clock.ts`** — the monotonic-clock rule, with a name.
- **`adapter/chunkWarming.ts`** — the warming loop (`docs/chunk-warming.md`).
- **`adapter/vhsStallSignals.ts`** — reading an engine's own stall verdicts.
- **`adapter/vhsRequestTimeout.ts`** — the caution above, implemented.
- **`serve/BlobServeStrategy.ts`** — the web's serving layer, and the shape yours takes.
- **`adapter/VideoJsAdapter.ts`** — how it is all wired to one engine.

Nothing in that list depends on `player-core` at runtime: they import types from
it and no more. The contract itself is `player-core/src/types.ts`.
