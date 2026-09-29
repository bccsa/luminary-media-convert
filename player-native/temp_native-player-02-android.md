# Plan 02: Android (Media3 ExoPlayer)

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

**Owner:** Dirk (who also owns plan 04, the conformance tests).

**Depends on:** [plan 01, the bridge](temp_native-player-01-bridge.md). Step 0
(the spike) can start now; everything after it waits for the bridge's gate.

**Kept in step with:** [plan 03, iOS](temp_native-player-03-ios.md). Every phase
ships on both platforms together; see the parity rules in
[the overview](temp_native-player-00-overview.md).

Everything here lives in `player-native/android/`. It builds the native structure
from [the overview](temp_native-player-00-overview.md#native-structure-both-platforms-the-same-names-file-for-file)
in Kotlin, then the real `Engine` behind it. It never changes `bridge.ts` or the
shared structure on its own: a change goes through Johan (bridge and iOS), and
through a plan 04 scenario.

**Capabilities:**

| Capability | Value |
|---|---|
| `variantSwitching` | `true` |
| `pictureInPicture` | `false` |
| `renderText` | `false` |
| `backgroundAudio` | `false` until phase 3b |
| `live` | `false` until phase 4 |
| `chunkWarming` | `false` until phase 5 |

## Step 0: device spike (before the bridge freezes)

In `example-app`, play one encrypted, byte-range, fMP4 multi-angle stream from
this encoder in bare ExoPlayer. Use only a routing `HlsDataSourceFactory`:
playlists from memory under `luminary://asset/…`, and the key from memory at
`luminary://key`.

Report to Johan (bridge owner):

- whether `Aes128DataSource` + `#EXT-X-BYTERANGE` + fMP4 plays correctly;
- how the IV is resolved;
- the time from `load` to first frame on a 2-hour, wide-ladder source;
- any URI or content-type constraint ExoPlayer imposes.

## Phase 1a: native structure (after the gate)

Build the overview's native structure in Kotlin, with the same names and semantics
as the Swift tree in plan 03:

- `LuminaryPlayerPlugin`, `BridgeTypes`, `PlayerRegistry`, `PlayerHost`,
  `AssetStore`, `KeyHolder`, `UriRouter`, `EventSink`, and the `Engine` interface;
- `UriRouter` is an `HlsDataSourceFactory` returning a routing `DataSource` per
  `open()`, routed by URI (never by `dataType`), with `isNetwork = false` for the
  in-memory sources;
- a `FakeEngine` test seam, in the shape plan 04's JUnit runner expects.

Done when plan 04's JUnit runner passes every v1 scenario against `FakeEngine`.

## Phase 1b: minimal `ExoEngine`

- **`engine/ExoEngine.kt` implements `Engine`**, using `HlsMediaSource.Factory`
  with `UriRouter` as its `HlsDataSourceFactory`.
- **Mapping `Player.Listener` to `EventSink`:**
  - `onIsPlayingChanged` → `playing` / `pause`
  - `STATE_BUFFERING` → `waiting`
  - `STATE_ENDED` → `ended`
  - `onTimelineChanged` → `durationchange` + `loadedmetadata`
  - `onTracksChanged` → `variants-updated` / `audiotracks-updated` (with
    `activeId`)
  - A main-looper poll drives `timeupdate` (4 Hz while playing) and `progress`
    (1 Hz, `bufferedPosition`). `EventSink` enforces those rates.
- **Variants.**
  - The id is `${height}_${bandwidth}` from the `Format`.
  - `setVariant` applies a `TrackSelectionParameters` override; `"auto"` clears it.
  - A rendition the decoder cannot play falls back to `auto`, followed by
    `variants-updated`.
- **Audio.** `setAudioTrack` uses a track override. The empty-then-list rule on
  `load` / `reattach` is enforced by `PlayerHost`, and the engine only reports.
- **`reattach()`** sets the same `MediaItem` again, calls `prepare()`, and
  restores position, rate and tracks.
- **Transfer accounting.**
  - The shared `OkHttpClient` (`media3-datasource-okhttp`), one per app, is what
    `UriRouter` falls through to for `https`.
  - In-memory sources keep `isNetwork = false`.
  - `Range` requests get a longer read timeout. The cold-chunk caution in
    `docs/suspension-safe-playback.md` explains why.
- **`error` mapping** (one file):

  | ExoPlayer error | `error` category |
  |---|---|
  | `ERROR_CODE_IO_*` | `network` |
  | parsing / decoding | `media` |
  | anything else | `other` |

- **Minimal full-screen.** `enterFullscreen` shows a full-window Media3
  `PlayerView`: system bars hidden, orientation following the sensor, the back
  gesture exiting. It emits `presentationchange`. The view only borrows the
  player.
- **Audio focus and headphones:** `handleAudioFocus` and
  `setHandleAudioBecomingNoisy(true)`.

## Phase 2: presentation

- Polish the presenter to match iOS behaviour. `exitFullscreen` pauses, except for
  audio-only; audio-only has no view.
- Lock-screen and notification skips come from `CreateOptions.skipBackSeconds` /
  `skipForwardSeconds`.

## Phase 3: the recovery obligation (`types.ts:494–521`)

- **Rungs 1–2:** `LoadErrorHandlingPolicy` is fed from `RecoveryPolicy` (the retry
  count and `reloadDelaysMs`). Do not add a second retry ladder on top of it.
- **On a fatal `PlaybackException`:**
  1. `prepare()` once. Skip this on a recurrence inside `escalationWindowMs`,
     measured with `SystemClock.elapsedRealtime()`.
  2. `reload-requested`. It is held while the app is backgrounded, and handed back
     by `resumed()`.
  3. Only then a fatal `error`.
- **Decoder-init failures** go straight to `reload-requested`.
- **A missing asset** (`FileNotFoundException`, not retried) goes to
  `reload-requested`.

## Phase 3b: background (`backgroundAudio`)

- **Service.** `PlaybackService` extends `MediaSessionService` and owns the
  `ExoEngine`. `PlayerHost` reaches it in-process.
- **Session metadata and wake mode.** Metadata comes from `nowPlaying`; the wake
  mode is `C.WAKE_MODE_NETWORK`.
- **Video in the background:** the video track is disabled, so only audio
  renditions download.
- **Manifest:**
  - foreground service type `mediaPlayback`;
  - `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MEDIA_PLAYBACK`;
  - confirm that media-session notifications are exempt from
    `POST_NOTIFICATIONS` on the target API level.
- **Session callbacks:**
  - `onConnect` accepts trusted controllers only.
  - `onPlaybackResumption` answers "nothing to resume".
  - `onTaskRemoved` stops playback and the service.

## Phase 4: live (`live`)

`LiveDataSource` handles `luminary://live/<n>` with one read per `open()`,
ported from `resolveLivePlaylist` (`player-core/src/policy/live.ts`):

1. fetch through OkHttp;
2. sniff the LMCENC magic (`LMCENC01`) and decrypt AES-128-CBC with
   `javax.crypto` (format in `docs/encrypted-sidecar-format.md`);
3. check the key: no `keyUri` but an AES-128 key present → `key-required`;
4. rewrite, ported from `rewriteMediaPlaylist`.

- **Failures** throw `InvalidResponseCodeException` carrying the upstream status.
- **A released address** waits, interruptibly.
- **Tests** read the fixtures from `player-core/src/test-support/fixtures/`.

## Phase 5: chunk warming (`chunkWarming`)

`ChunkWarmer.kt` is a port of `player-web/src/adapter/chunkWarming.ts`. It
follows all nine rules in `docs/chunk-warming.md`:

- a 1 s tick on the main looper reads `max(bufferedPosition, currentPosition)`;
- range requests go out on an IO thread through the shared `OkHttpClient`;
- it stops once every warmable boundary has been warmed.

## Android-specific edge cases

- **`visibilitychange` is unreliable** in Android's WebView. The bridge also
  listens for `@capacitor/app` `resume`.
- **Activity recreation.** If a host changes `configChanges`, the presenter
  re-attaches without rebuilding the player.
- **Cleartext.** A local `http://` MinIO needs a debug-only
  `network_security_config` in `example-app`.
- **Cold chunks.** Test on a throttled network behind a CDN edge; a local MinIO
  is never cold.

## Verification

- **Unit tests:** JUnit + Robolectric, plus a `TestExoPlayerBuilder` run of an
  encrypted fixture served entirely through `UriRouter` and a fake HTTP upstream.
- **Conformance:** plan 04's JUnit runner passes, against `FakeEngine` (phase 1a)
  and with `ExoEngine` swapped in wherever a scenario allows it.
- **Device pass, the same list as iOS:**
  - encrypted and plain playback;
  - audio language, audio-only and quality pinning;
  - an angle switch;
  - full-screen in and out, and the back gesture;
  - 10+ minutes on the lock screen (phase 3b);
  - resume catching the UI up;
  - unplugging headphones, and losing audio focus;
  - killing the renderer, with no orphaned audio;
  - swiping the app away;
  - a third-party live stream (phase 4);
  - a throttled network behind a CDN;
  - no leaks (LeakCanary).
