# Chunk warming — cross-implementation spec

Byte-range output packs many segments into a few large chunk objects: all
renditions of one camera angle share a chain, the audio groups share another,
and a segment is a `#EXT-X-BYTERANGE` slice of the object it lives in. That is
good for the origin — a handful of objects instead of thousands — but it moves
where the first-request cost lands.

A byte-range-capable delivery edge answers a ranged request as soon as it can,
while pulling the whole object from the origin behind it. So the **first**
request into a chunk is the slow one: the moment the engine's buffer crosses
from chunk N into chunk N+1, that object may not be at the edge yet, and the
viewer waits for a backhaul that has only just started. Warming asks for a few
kilobytes of the next chunk *slightly before* the crossing, so the backhaul runs
while the engine is still happily reading the current object.

The bytes fetched are discarded ciphertext. Nothing is decrypted, parsed,
cached, or handed to the engine — the request exists to make the edge fetch the
object, not to produce data anybody uses.

## Where the responsibility splits

| Piece | Owner | Why there |
|---|---|---|
| Which chunk objects exist, and what media time each covers | **player-core** — `buildChunkSchedules` | A property of the OUTPUT, not of any engine. Pure function, plain-data result: it serializes across a native bridge unchanged |
| Whether to warm, how far ahead, how many bytes, whether to log | **player-core** — `PlayerControllerOptions.prefetch`, resolved in `PlayerController` | Policy stays in one place so every platform warms identically |
| The pacing loop: sampling the buffer, deciding the moment, issuing the request | **The adapter** — `PlayerAdapter.warmChunks` | Platform work. A JS interval is throttled or suspended once the app is backgrounded, exactly when a native player carries on playing |

The wrapper calls `warmChunks(schedules, options)` on every source attach —
initial load, angle switch, recovery reload — with the chains that attach will
actually pull, and calls it with an **empty array** to mean *stop*. Implementing
it is optional: an adapter that omits it simply never warms, and playback is
correct, just colder at boundaries.

## Schedules

One schedule per chunk chain; one entry per contiguous run of segments sharing
an object:

```ts
interface ChunkBoundary {
    url: string;   // absolute URL of the chunk object
    start: number; // media time the run starts at, seconds
    end: number;   // media time the run ends at, seconds
}
```

Chains are deduped by their first chunk URL, because every rendition of an angle
references the same chunk files — one schedule covers all of them, and no name
parsing is needed to work out what belongs where. Playlists whose segments carry
no `#EXT-X-BYTERANGE` produce nothing: there are no shared objects to warm, so
warming disables itself on anything but byte-range output rather than issuing
pointless requests.

### Init segments and spliced (quick-trim) playlists

Init segments are never part of a chunk chain: they are standalone objects in
the stream's own directory, whatever their count — a quick-trim output carries
one `#EXT-X-MAP` per spliced part. Schedules ignore MAPs entirely; inits are
small, fetched once by the engine, and not worth warming.

A spliced playlist also carries `#EXT-X-DISCONTINUITY` between parts. Boundary
`start`/`end` times remain the cumulative `#EXTINF` sum across the whole
playlist — the playlist timeline — with no reset at a discontinuity. The loop
compares those times against the engine's buffered media time, so the contract
assumes the engine maps playlist positions onto the media timeline 1:1 across
discontinuities (hls.js does; it re-anchors each discontinuity at the running
EXTINF total). An engine that restamps discontinuities differently would drift
the comparison; warming degrades to firing early or late, never to a wrong
request, because the boundary URL list is unaffected. Verify against a spliced
output when porting an adapter.

## Normative loop semantics

An implementation of `warmChunks` must:

1. **Sample the buffer front, with the playhead as the floor** —
   `max(bufferedEnd, currentTime)` off its own media element. A playhead-only
   trigger is wrong: the engine buffers tens of seconds ahead and crosses the
   boundary long before the viewer reaches it, so the warm would land *after*
   the cold request it exists to prevent. An adapter that cannot report buffered
   progress degrades to the playhead rather than to nothing.
2. **Warm on approach.** For each schedule, find the boundary containing the
   watermark; when `boundary.end - watermark <= leadSeconds`, warm the **next**
   boundary — but only when its `url` differs, since a run continuing in the
   same object needs nothing.
3. **Never warm the first chunk.** The engine's own start-up requests fetch it;
   there is nothing to get ahead of.
4. **Warm each URL at most once per attached source**, marking it warmed
   **before** the request goes out — two ticks must not both fire — and never
   retrying a failure. The engine's own request is the fallback: later and
   slower, which is the un-warmed status quo anyway.
5. **Request `Range: bytes=0-<warmBytes - 1>` through the supplied
   `fetchImpl`**, read the body to completion, discard it. Using the supplied
   fetch matters: an auth-wrapped fetch or a native HTTP shim must reach these
   requests too.
6. **Swallow every failure.** Warming is advisory in both directions — it must
   not block a load, surface an error, or change anything the viewer sees.
   Report to `log` and move on.
7. **Keep ticking while paused.** A static watermark fetches nothing by itself,
   and a player parked just short of a boundary gets its next chunk warmed
   before the viewer presses play again.
8. **Sample about once a second.** Boundaries are tens of seconds apart; finer
   sampling buys nothing.
9. **Stop** on an empty-schedules call, when a new source replaces the current
   one, and on `destroy()`. A loop that outlives its source warms chunks nothing
   is going to play.

## Tuning

Both knobs live on `PlayerControllerOptions.prefetch` and reach the adapter
already resolved, as `ChunkWarmOptions` — an adapter is handed decisions, never
a half-filled bag whose defaults it would have to know.

- **`leadSeconds`, default 60.** Generous on purpose: a cap-sized chunk on a
  slow backhaul can take tens of seconds to land at the edge in full, and
  eviction between warm and use is not a real risk at this horizon — edges evict
  over hours, not seconds. The cost of leading long is an occasional backhaul
  for a boundary the viewer never reaches, bounded by how few chunk objects an
  asset has. Note the trigger is the buffer front, which already runs ahead of
  the playhead by the engine's buffer length: the viewer is further from the
  boundary than this number reads.
- **`warmBytes`, default 65 536.** Enough to make the edge start pulling the
  object; small enough that a wasted warm costs nothing worth counting.
- **`enabled`, default on.** For hosts that want no warming at all: a proxy that
  already warms, a metered connection, a test counting requests.
- **`debug`, default off.** Warming is invisible by design — one small ranged
  request per chunk among hundreds of media requests — so this narrates it
  instead: the schedule shape when armed, every warm with its trigger context
  (`buffer front 118.2s, 4.7s left in v0_2.m4s, Range: bytes=0-65535`), and the
  failures the fetch path deliberately swallows. Lines are prefixed
  `[luminary-prefetch]` by the wrapper.

## Porting to a native adapter

Schedules are plain data: build them in JS with `buildChunkSchedules` and hand
them across the bridge, or rebuild them natively from the same playlists — both
are fine, and the result must be identical either way.

The loop is the part that cannot be shared. A JS interval in a Capacitor
WebView is throttled when the app is backgrounded and may be suspended outright
when the screen locks, while AVPlayer or ExoPlayer keeps playing from its own
buffer — precisely the situation where a boundary crossing goes unwarmed and the
viewer hears the gap. Implement the ticker beside the native player, in the
platform's own scheduling primitives, following the semantics above.

## Reference implementations

- Schedule builder: `player-core/src/prefetch.ts` (`buildChunkSchedules`).
- Contract and option shape: `player-core/src/types.ts`
  (`PlayerAdapter.warmChunks`, `ChunkWarmOptions`, `ChunkBoundary`).
- Policy resolution: `player-core/src/controller.ts`
  (`PlayerController.updateChunkWarming`).
- The loop, for the web: `player-web/src/adapter/chunkWarming.ts`
  (`ChunkPrefetcher`), wired up in `player-web/src/adapter/HlsJsAdapter.ts`.
- Behaviour pinned by `player-web/__tests__/chunk-warming.test.ts` (the loop),
  `player-web/__tests__/adapter.test.ts` (the wiring and its lifecycle) and
  `player-core/src/controller.spec.ts` (the handover).
