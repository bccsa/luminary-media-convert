# Plan 03: iOS (AVFoundation)

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

**Owner:** Johan (who also owns plan 01, the bridge).

**Depends on:** [plan 01, the bridge](temp_native-player-01-bridge.md). Step 0 (the
spike) can start now; everything after it waits for the bridge's gate.

**Kept in step with:** [plan 02, Android](temp_native-player-02-android.md). Every
phase ships on both platforms together; see the parity rules in
[the overview](temp_native-player-00-overview.md).

Everything here lives in `player-native/ios/`, which is packaged with a podspec
and registered from the host app. That replaces the original design's plan of
adding the files to the app target. This plan builds the native structure from
[the overview](temp_native-player-00-overview.md#native-structure-both-platforms-the-same-names-file-for-file)
in Swift, then the real `Engine` behind it. A change to `bridge.ts` or to the
shared structure is agreed with Dirk (Android and conformance tests), and lands
with a plan 04 scenario.

Baseline: iOS 15.0, Capacitor 8, CocoaPods.

**Capabilities:**

| Capability | Value |
|---|---|
| `variantSwitching` | `false` (AVPlayer can cap bitrate but not pin a rendition; `player-core` turns a quality choice into a reload with a cap) |
| `pictureInPicture` | `true` |
| `renderText` | `false` |
| `backgroundAudio` | `false` until phase 3b |
| `live` | `false` until phase 4 |
| `chunkWarming` | `false` until phase 5 |

## Status (2026-09-30)

- **Step 0: done.** On an iPhone 13 Pro, AVPlayer played this encoder's encrypted, two-angle,
  byte-range fMP4 output with every playlist and the key answered from memory. Results are in
  `spike/FINDINGS.md`.
- **Phase 1a: the core is done; two items remain.** The native structure is in
  `ios/Sources/LuminaryPlayerCore/`, ported file for file from the Kotlin tree, and all 16 v1
  scenarios pass on the real `PlayerRegistry` over a `FakeEngine` (`swift test`). It follows
  Android's two structural choices: `Engine.hasVideo`, and `EventSink` owning the emission rules.
  The harness calls `PlayerRegistry.call`, the decode path the plugin will use.
- **`UriRouter` is the `AVAssetResourceLoaderDelegate`,** answering on its own serial queue.
  It follows the spike's findings: it reports the content type as a UTI, answers a request that
  asks for data alone, and honours the requested range. `CoreTests` pins each rule, and loads a
  real `AVURLAsset` through it on macOS.
- **Still open in 1a:**
  - `LuminaryPlayerPlugin` (the Capacitor shim);
  - the podspec.

  `LuminaryPlayerCore` imports no Capacitor, UIKit or AVKit, so the scenarios run with
  `swift test` on macOS. The plugin sits on top of it, in a target of its own. The core builds in
  Swift 5 language mode, because AVFoundation's actor annotations differ between SDKs (Xcode 16
  marks `AVPlayerItem.currentMediaSelection` main-actor, later SDKs do not). In Swift 6 mode each
  difference is an error, and one failed CI. The tests stay in Swift 6 mode.
- **Phase 1b: `AVPlayerEngine` built, and it plays on the device.** It sits in `LuminaryPlayerCore`
  and ports `ExoEngine` signal for signal. The one difference is that there is no separate time
  observer: `EventSink` owns the 4 Hz `timeupdate`, as on Android. The spike's `-engine` mode drove the real `PlayerRegistry` → `AVPlayerEngine` through the
  bridge's own calls on an iPhone 13 Pro, with the encrypted 2-hour stream:
  - first `load` to `playing` in 1.3 s; an angle switch in 294 ms;
  - `timeupdate` at 4 Hz, and `progress` at 1 Hz;
  - audio switch, seek, pause, `resumed` and `destroy` all behave as the contract says, with no
    events after `destroy`.
- **Minimal full-screen: done, and verified on the device.** The presenter is named
  `FullscreenPresenter`, Android's name, rather than this plan's `PlayerPresenter`. It is a protocol
  in the core, implemented by `PlayerViewControllerPresenter` in the iOS-only `LuminaryPlayerUI`
  target. That implementation presents an `AVPlayerViewController` over a view controller it is
  handed (the plugin will pass the bridge's), so it waits on nothing. On the device, through the
  bridge:
  - `enterFullscreen` and `exitFullscreen` emit `presentationchange`, and leaving pauses;
  - a viewer closing the view does the same.

  Two device findings are built in:
  - each view reports only its own dismissal, because one still animating out otherwise ended the
    full-screen that replaced it;
  - the player is detached before dismissing, because `AVPlayerViewController` pauses its player
    as it disappears, which stalled a full-screen that followed.

  Known: `play` within about 50 ms of `exitFullscreen`, while the dismissal is still animating,
  shows a `pause` blip between `waiting` and `playing`. PiP is phase 2.
- **Follow-up: audio options are listed per tier.** AVPlayer lists each language once per audio
  group (HD and SD), which gives 8 options for 4 languages, the second set suffixed `#n`. Agree
  with Dirk to list one per language.
- **Still to agree with Dirk:** packaging (SwiftPM and a podspec from the same sources), and the
  `warmChunks` shape (`ChunkBoundary[][]`, as `bridge.ts` says and both native sides validate).

## What carries over from the original "AVPlayer plugin design"

- **`PlayerSession`**: one `AVPlayer`, reused through `replaceCurrentItem`. It is
  now the `AVPlayerEngine` behind `Engine`.
- **`AudioSessionController`**: set late (on the first `load`), not at launch;
  handles interruptions and route changes; deactivates with
  `.notifyOthersOnDeactivation` on destroy.
- **`NowPlayingController`**: wired by hand, since `MPNowPlayingSession` needs
  iOS 16. It updates only on state changes, not on every tick.
- **`PlayerPresenter`**: `AVPlayerViewController`, PiP, `presentationchange`. It
  only borrows the player, never owns it.
- **`PlayerEvent.swift`**: the single file that maps `NSError` to an error
  category.
- **Rules:** the main actor for every `AVPlayer`, KVO and UI call (only the loader
  runs on its own queue); `[weak self]` in closures and stored KVO tokens; one
  teardown method; the 4 Hz / 1 Hz event rates.

## What changes from the original design

These changes follow from `player-core` at `f3839f3` and from the bridge's v1
protocol:

- **The protocol.**
  - A JS-created `loadId` plus `playerId`, instead of `sessionId`.
  - The `luminary://asset | key | live` scheme, instead of `lmc://p/N.m3u8`.
  - A `contentType` per asset: VTTs must be served as WebVTT, not as a playlist.
  - `getInfo`, `reset`, `create`, `putAssets`, `putLive`, `releaseAssets`,
    `reattach` and `resumed`.
  - `seek { position, exact }`; `enterFullscreen` / `exitFullscreen` instead of
    `present` / `dismiss`; `{ code, message }` on `error`.
- **Recovery is the adapter's** (phase 3). `player-core` has no retry logic, and a
  fatal `error` ends playback.
- **`reattach()`** is a required method.
- **The resume handshake and the held reload.**
- **The audio-track empty-then-list rule.**
- **Chunk warming** (phase 5). It warms the CDN edge's cold chunk objects; it has
  nothing to do with AVPlayer's buffer.

## Step 0: device spike (before the bridge freezes)

In `example-app`, play one encrypted, byte-range, fMP4 multi-angle stream from
this encoder:

- `AVURLAsset(luminary://asset/…)` with the resource-loader delegate;
- playlists served from memory;
- `#EXT-X-KEY URI="luminary://key"` answered from memory;
- https segments going direct.

Fold these findings into `bridge.ts` before the freeze (plan 01), and share them with Dirk:

- whether byte-range fMP4 through a resource loader works with these streams;
- which content types or UTIs the loader must set (playlist, VTT, key);
- whether resource-loader bytes skew the bandwidth estimate;
- the time from `load` to first frame on a 2-hour, wide-ladder source.

Check the ladder's H.264 variants and their `CODECS` attributes on the same run.

## Phase 1a: native structure (after the gate)

Build the overview's native structure in Swift, with the same names and semantics
as the Kotlin tree in plan 02:

- `LuminaryPlayerPlugin` (the Capacitor 8 `CAPBridgedPlugin` style), `BridgeTypes`,
  `PlayerRegistry`, `PlayerHost`, `AssetStore`, `KeyHolder`, `UriRouter`,
  `EventSink`, and the `Engine` protocol;
- `UriRouter` is an `AVAssetResourceLoaderDelegate` on its own serial queue;
- a `FakeEngine` test seam, in the shape plan 04's XCTest runner expects;
- the podspec, registered from the host app.

Done when plan 04's XCTest runner passes every v1 scenario against `FakeEngine`.

## Phase 1b: minimal `AVPlayerEngine`

- **`AVPlayerEngine` implements `Engine`.** It builds `AVURLAsset(masterUri)`,
  sets `UriRouter` as its `resourceLoader` delegate, and calls
  `replaceCurrentItem`.
- **Mapping to `EventSink`:**

  | AVFoundation signal | Event |
  |---|---|
  | periodic time observer | `timeupdate` |
  | KVO `item.duration` | `durationchange`, plus `loadedmetadata` once the duration and seekable range are known |
  | `loadedTimeRanges` | `progress` |
  | `timeControlStatus` | `playing` / `pause` / `waiting` |
  | seek completion | `seeked` |
  | `DidPlayToEndTime` | `ended` |
  | `AVPlayerItemPlaybackStalled` | `stalled` |
  | the audible `AVMediaSelectionGroup` | `audiotracks-updated` (with `activeId`) |

  `variants-updated` is always empty, because `variantSwitching` is false.
- **Audio.** `setAudioTrack` selects within the audible group. The
  empty-then-list rule is enforced by `PlayerHost`.
- **`reattach()`** builds a new `AVPlayerItem` from the same assets, then restores
  position, rate and the selection.
- **`setVariant`** is never reached: the plugin rejects it with `unsupported`.
- **Minimal full-screen.** `enterFullscreen` presents `AVPlayerViewController`
  over the bridge view controller and emits `presentationchange`.

## Phase 2: presentation

- **The presenter.** Enable PiP (`allowsPictureInPicturePlayback`,
  `canStartPictureInPictureAutomaticallyFromInline`). Restore the UI when PiP
  stops. `exitFullscreen` pauses, except for audio-only; audio-only has no view.
- **Remote-command skips** come from `CreateOptions.skipBackSeconds` /
  `skipForwardSeconds`, and match Android's.

## Phase 3: the recovery obligation (`types.ts:494–521`)

- **Port `player-web/src/drivers/RecoveryLadder.ts` and `drivers/clock.ts` to
  Swift.** `clock.ts` is the monotonic-clock rule; use a clock that does not jump
  across a suspension.
- **The order of recovery:**
  1. an in-place attempt, where AVPlayer offers one;
  2. `reattach`, with backoff from `RecoveryPolicy`;
  3. `reload-requested`, held while suspended and returned by `resumed()`;
  4. only then a fatal `error`.
- **What feeds the ladder:** `item.status == .failed`, `FailedToPlayToEndTime`
  and error-log entries. They do not go straight to JS.

## Phase 3b: background (`backgroundAudio`)

- `UIBackgroundModes: audio`.
- `audiovisualBackgroundPlaybackPolicy = .continuesIfPossible`: video carries on
  as audio, and PiP starts automatically where available.
- `NowPlayingController` shows `nowPlaying` (title, subtitle, `artworkUrl`),
  duration, elapsed time and rate. Remote commands cover play, pause, the skips
  and scrubbing.
- Interruptions resume on `.shouldResume`. Unplugging headphones emits `pause`.

## Phase 4: live (`live`)

`LiveResolver` answers `luminary://live/<n>` asynchronously in the resource-loader
delegate, on the loader queue, with one read per request. It is ported from
`resolveLivePlaylist` (`player-core/src/policy/live.ts`):

1. fetch with `URLSession`;
2. sniff the LMCENC magic and decrypt AES-128-CBC with CommonCrypto (format in
   `docs/encrypted-sidecar-format.md`);
3. key check: no `keyUri` but an AES-128 key present → `key-required`;
4. rewrite, ported from `rewriteMediaPlaylist`.

A request for a released address is left unanswered until AVPlayer cancels it.
Tests read the fixtures from `player-core/src/test-support/fixtures/`.

## Phase 5: chunk warming (`chunkWarming`)

A port of `player-web/src/adapter/chunkWarming.ts` that follows all nine rules in
`docs/chunk-warming.md`:

- driven by a periodic time observer that reads `max(bufferedEnd, currentTime)`;
- range requests through `URLSession`;
- stops once every warmable boundary has been warmed.

## iOS-specific edge cases

- **AirPlay** cannot fetch `luminary://` playlists, so it is off for native
  playback.
- **The audio session is shared** with `WKWebView`. Set it late and restore it on
  destroy.
- **CORS.** `player-core` fetches playlists from `capacitor://localhost`, so the
  bucket must allow that origin.
- **Cleartext.** A local `http://` MinIO needs a debug-only ATS exception in
  `example-app`.
- **Memory.** Keep bridge traffic small (4 Hz / 1 Hz): the iPhone 7/8 have 2 GB
  of RAM.

## Verification

- **XCTest:** plan 04's runner over `conformance/*.json`, plus unit tests of
  `AVPlayerEngine`'s event mapping and the Swift ports (ladder, live resolver)
  against the shared fixtures.
- **Device pass,** on an iPhone 7/8 (iOS 15) and a current iPhone. It is the same
  list as Android:
  - encrypted and plain playback;
  - audio language, the audio-only toggle and quality (as a reload with a cap);
  - an angle switch;
  - full-screen and PiP;
  - 10+ minutes on the lock screen (phase 3b);
  - resume catching the UI up;
  - a call interruption, and unplugging headphones;
  - navigating away mid-play (check for leaks in Instruments);
  - rotation;
  - a third-party live stream (phase 4);
  - a throttled network behind a CDN.
