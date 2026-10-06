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

## Status (2026-10-01)

- **Phase 1a: done.** The overview's native structure is in
  `android/src/main/java/org/bccsa/luminary/player/`. `makeConformanceHarness()`
  runs the real `PlayerRegistry` on a `FakeEngine`, and all 16 v1 scenarios pass.
  The plugin and the harness share one decode path: the plugin only stringifies
  `call.data` and hands it to `PlayerRegistry.call`.
- **Phase 1b: built, and not yet tried on a device.** `engine/ExoEngine.kt`,
  `engine/FullscreenPresenter.kt` and `engine/ErrorMapping.kt` are in place.
  `ExoEngineTest` plays an encrypted, byte-range fMP4 fixture to the end through
  `UriRouter` on a real ExoPlayer (Media3's test renderers). The fixture comes
  from `src/test/make-encrypted-fixture.py`.
- **Step 0 (the device spike) is still open: it needs a run on a device.** The spike logs the
  first frame and, now, which decoder ExoPlayer picked and whether it is hardware
  (`decoder video …` in `adb logcat -s LmcSpike`). Record a payload from a 2-hour, wide-ladder
  source with `make-payload.mjs --android`, then run `--ez autorun true`.
- **To agree with Johan:**
  - `Engine` gained `val hasVideo`. `PlayerHost` needs it for the
    `exitFullscreen` rule, and scenario 14 pins that rule.
  - `EventSink` carries the engine-facing signals (`readyToPlay`, `playing`,
    `paused`, `seeked`, `bufferedTo`, …). It owns the rules the reference keeps
    in `PlayerHost`: `durationchange` only on a change, and `variants-updated`
    only with `variantSwitching`.
  - The reference's `warmChunks` shape says `schedules` is an array of objects.
    `bridge.ts` says `ChunkBoundary[][]`, and Kotlin validates that. No scenario
    reaches this yet.

- **Phase 2: built on Android, not yet seen on a device.** All of it is in the plugin, so the
  Player Lab and the spike get it too.
  - **Full-screen controls follow `player-web`'s skin** (`engine/SkinControls.kt`): a 30% scrim,
    a 96 dp play / pause with the skip circles at ±72 dp, a slim progress bar that leaves the
    corner to the exit button, the audio and rate menus top left (the time, the spinner and mute
    came later, see below). They fade after
    3 s of playing, a tap shows or hides them, and a double tap or the back gesture leaves.
  - **Skips are 5, 10 or 30 s,** snapped from `skipBackSeconds` / `skipForwardSeconds` exactly as
    `snapSkipSeconds` does in `player-web`, so a label and its jump agree. `0` means no button.
  - **The notification and lock screen get skip buttons** through an in-process `MediaSession`
    (`media3-session`), with the same seconds, and show `nowPlaying`: `Engine.load` carries it into
    the item's `MediaMetadata` (title, subtitle as artist, artwork the session fetches). Keeping the
    session alive with the screen locked is the background service, phase 3b.
  - **Audio-only has no view.** `enterFullscreen` does nothing for an item with no video track,
    and a view raised before the tracks were known comes down when they show none.
  - **Play at the end restarts from 0** and emits `seeked`, as iOS does.
  - **A rate or language chosen in native full-screen reaches the controller.** The bridge gained
    a `ratechange` event (additive, so no protocol bump); `NativeBridgeAdapter` now reads `activeId`
    and tells a viewer's pick from the answer to its own call, and `createNativePlayer` hands the
    pick to the controller. Scenario 18 pins it, and all three runners pass it.
    `ExoEngine` rounds the speed to three decimals, since ExoPlayer keeps it as a float. **For Johan
    to review** (bridge owner, iOS).

- **Phase 3b: built, and verified on the emulator.**
  - `PlaybackService` (a `MediaSessionService`) hosts the engine's session; the engine keeps the
    player and the session, and starts the service on a load. Media3 runs it in the foreground
    (`mediaPlayback`) with the media notification while playing; a media-session notification
    needs no `POST_NOTIFICATIONS`. The plugin's manifest declares the service and the
    `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` and `WAKE_LOCK` permissions.
  - Wake mode `C.WAKE_MODE_NETWORK`. In the background the video track is disabled (the app's
    `ProcessLifecycleOwner`), so only audio downloads; it comes back with the app.
  - The session accepts trusted controllers only, answers playback resumption with nothing, and
    swiping the app away pauses and stops the service.
  - On the emulator: playing on in the background and for 25 s locked; pause, play and the
    forward skip from media buttons while locked; the page catching up on return (`resumed`).
  - `backgroundAudio` is on, on both platforms together (parity-gated).

- **Phases 3, 4, 5 and the full-screen skin: built, with the iOS findings of plan 07 in them, and
  verified on a phone (2026-10-06).**
  - **Phase 3, the recovery ladder** (`RecoveryLadder.kt`, ported from the Swift one with plan 07's
    A5 to A7 fixes: a rung is dropped when playback recovers, the failure is reported once, a held
    reload goes with it). Rung 0 is ExoPlayer's `prepare()`, rung 1 a re-attach, then
    `reload-requested`, held while the app is in the background and handed back by `resumed()`.
    A decoder-init failure or a missing asset skips the repairs a re-attach would make.
    ExoPlayer's loader retries stay short (two, spaced by `reloadDelaysMs`): the ladder only sees
    what ExoPlayer has given up on, so the two do not stack. `stalled` comes from ExoPlayer going
    from READY back to BUFFERING with nothing asked of it. The wedge heuristic of the iOS engine
    (an error log read as a stall) has no Android counterpart, because ExoPlayer's own load
    errors already end in a `PlaybackException`. `maxReloadAttempts` and `warmBytes` are bounded
    like iOS (A9).
  - **Phase 4, live** (`LiveResolver.kt`, `MediaPlaylistRewrite.kt`, `LiveDataSource` in
    `UriRouter.kt`): one read per ExoPlayer playlist request, LMCENC decrypted, AES-128 refused
    without a key URI, the rewrite resolving URIs by RFC 3986 on the strings, a 10 s read
    timeout, and plan 07's B2, B3, B4 and B5 in from the start. A released address waits until
    the engine cancels it. A live address holds its key as bytes, zeroed when its generation is
    purged. A failed read reaches the engine as the status a direct request would have met.
  - **Phase 5, chunk warming** (`ChunkWarmer.kt`): the nine rules of `docs/chunk-warming.md`,
    the loop on the main looper's clock, the request through the shared OkHttp client.
  - **Full-screen skin:** video.js's own glyphs (`extract-videojs-icons.mjs` writes
    `VideoJsIcons.kt` too), the time text, a spinner that stands in for play / pause while waiting,
    and a mute button. Plan 07's C3 (a tap on another control closes a menu) is in, and the rate
    button reports its value to a screen reader (C4). Picture in picture and subtitles are not
    built: no plan schedules them for Android yet.
  - **Still open on Android:** `requestHeaders` is decoded and dropped, as on iOS (C9);
    the engine's controls act on the player directly rather than through an engine-level command
    object, which is fine while no state lives only in the engine.

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
| `backgroundAudio` | `true` (phase 3b) |
| `live` | `true` (phase 4) |
| `chunkWarming` | `true` (phase 5) |

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
