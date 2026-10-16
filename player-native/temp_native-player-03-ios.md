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
| `backgroundAudio` | `true` (phase 3b) |
| `live` | `true` (since 2026-10-06; plays on the device) |
| `chunkWarming` | `true` (2026-10-07), as on Android since its phase 5. Not yet seen to help on a real byte-range CDN, on either platform |
| `inlineVideo`, `muting`, `subtitleSelection`, `airPlay` | `true` (2026-10-06; see plan 08 and the status below) |

## Status (2026-10-06)

What the iOS side does now, on top of everything in the 2026-10-01 status below. All of it is on
`feat/native-player-bridge`, with Swift tests (113 core, 14 conformance), conformance scenarios 19 to
26 and CI green on both platforms.

- **Video in the page** (`inlineVideo`, `setInlineFrame`): the picture sits behind a transparent web
  view, follows its frame, and survives full-screen and picture in picture. Turning the phone
  sideways opens full-screen for a landscape video that plays; the full-screen button opens it
  otherwise. Device-verified.
- **Controls the page draws:** `setMuted` (and `mutedchange`), `setSubtitleTrack`,
  `startPictureInPicture`, and AirPlay. Device-verified.
- **AirPlay** (`airPlay`, `showAirPlayPicker`, `airplaychange`): the page's button shows only while
  a device is detected; native full-screen has Apple's own picker in its top row. **Verified on a
  Mac as the receiver, video and sound.** An Apple TV or an AirPlay speaker has not been tried.
- **`live` is on** and plays on the device (the SCC live stream).
- **Native full-screen speaks the app's language** (`enterFullscreen` carries the texts).
- **Now Playing:** title, duration and elapsed time as before; artwork is cropped to a square, and
  `fallbackArtworkUrl` (a `data:` JPEG from the host) is used when the post's own picture is absent,
  answers an error or is not an image.
- **The engine recreates its `AVPlayer`** when iOS resets its media services, and carries on from where
  it was (unit-tested; a reset cannot be triggered on demand, so not exercised on the device).
- **The review** ([plan 07](temp_native-player-07-ios-review.md)): groups A, B and C are fixed. What
  is left is minor, or can only be seen on a device.
- **`bandwidthEstimate`** (a hint from the host's speed probe) reaches the load; AVPlayer has no way to
  seed an estimate, so iOS ignores it.

**Open:**

- **The slow-phone pass.** Not done: no iPhone 7 or 8 (iOS 15) to hand. Playback, 10+ minutes on the
  lock screen, full-screen, picture in picture, an angle switch, and the memory budget the edge-case
  list names.
- **Chunk warming** (`chunkWarming`): on for both platforms (iOS since 2026-10-07, to match Android).
  Still open: a run behind a real byte-range CDN, on both, to show it earns its keep. iOS skips it on
  Low Data Mode, and the app's Data Saver turns it off through `prefetch.enabled`.
- **Conformance for the ladder and for a live answer:** the shared part of the ladder scenarios
  (ExoPlayer's rungs differ), and a route result shape for a live answer.
- **Packaging:** SwiftPM and the podspec from the same sources, to agree with Dirk.
- **AirPlay on an Apple TV and a speaker.**

## Status (2026-10-01)

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
- **Plugin shim and podspec: done.**
  - `ios/Sources/LuminaryPlayerPlugin/LuminaryPlayerPlugin.swift` is the Capacitor shim. As on
    Android, every method hands `call.options` to `PlayerRegistry.call` on the main thread,
    rejects with the bridge's codes, and sends events through `notifyListeners`.
  - `LuminaryMediaConverterPlayerNative.podspec` packages the core, the UI and the shim as one
    module for CocoaPods hosts. Capacitor names the pod after the npm package.
  - The Swift package keeps the core and the UI only: Capacitor's Swift package is iOS-only, and
    `swift test` builds every target on macOS.
  - Verified in Dirk's Player Lab, which now has `ios/`, on the device: `createNativePlayer` in
    the web view drives AVPlayer through the plugin. A scripted run measured load 84 ms, play
    562 ms, angle switches of 475 ms (playing) and 363 ms (paused), and full-screen in and out.
- **Play at the end restarts from 0,** as a video element does, and emits `seeked`; AVPlayer
  would otherwise stay at the end. Android needs the same rule.

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
  shows a `pause` blip between `waiting` and `playing`.
- **Protocol v1: frozen with Dirk.** The bridge lists one audio track per language
  (`AudioRenditions`: the encoder names the tiers apart, "HD Audio eng" and "SD Audio eng", so the
  key is `LANGUAGE`), and a load starts on the stream's `DEFAULT=YES` rendition: the player no
  longer applies the device's language preferences. AVKit's own full-screen audio menu still
  lists every rendition, twice for a two-tier ladder; its API offers no filter.
- **Phase 2: done, and verified on the device.**
  - **Picture in picture.** AVKit takes the full-screen view down when picture in picture starts;
    that is not the viewer leaving, so playback goes on. Returning to full-screen puts the same
    view back; closing picture in picture is leaving, and pauses. `presentationchange` reports
    `pip`, and `getInfo()` reports `pictureInPicture: true`. A host needs `audio` in
    `UIBackgroundModes` for the system to offer picture in picture; the Player Lab declares it.
  - **Lock-screen and Control Center skips** (`RemoteSkips`), 5, 10 or 30 s snapped from
    `CreateOptions` by `SkipSeconds`, a port of Android's. A direction with no seconds has no
    button.
  - **Audio-only has no view.** `enterFullscreen` does nothing without video, and a view raised
    before the tracks were known comes down once they show none. A track that has not reported
    its type counts as video: a seek past the buffer rebuilds AVPlayer's track list, and for a
    moment only the sound track reports, which closed the view on a Control Center skip.
- **Phase 3b: done, and verified on the device.**
  - `NowPlayingController` is the one publisher of Now Playing, presented or not: AVKit's view
    is told not to publish its own (`updatesNowPlayingInfoCenter = false`). It shows `nowPlaying`
    (title, subtitle, artwork fetched from `artworkUrl`) with duration, elapsed time and rate,
    and handles play, pause, toggle, scrubbing and the skips, which moved into it from phase 2's
    `RemoteSkips`. `Engine.load` now carries `nowPlaying`.
  - The engine activates a playback audio session on `play`, and plays on in the background
    (`audiovisualBackgroundPlaybackPolicy = .continuesIfPossible`). Audio-only plays on with the
    screen locked, controlled from the lock screen.
  - An interruption resumes on `.shouldResume` when playback was running as it began; unplugged
    headphones need nothing, since AVPlayer pauses and `pause` follows. Tried with a timer: audio-only
    paused when it rang and resumed when it was stopped.
  - `backgroundAudio` is on, together with Android (parity-gated).
  - The Player Lab sets no `nowPlaying` yet: how a host passes a title and artwork is part of the
    host component, which moves into `player-native` with the integration.
- **Phase 3: the ladder, built and verified on the device; two items open.**
  - `RecoveryLadder` ports `player-web/src/drivers/RecoveryLadder.ts` on the core's monotonic
    `Clock`, with unit tests on virtual time. AVPlayer has no in-place repair, so rung 0 is skipped:
    re-attach at +2 s, then `reload-requested` at +4 s and +8 s, and only then a fatal `error`. The
    load's `RecoveryPolicy` now reaches the engine.
  - A failed item no longer reports a pause: the failure is the ladder's, and the controller
    still sees playback as wanted when it rebuilds the source. The engine keeps the viewer's intent
    (every play and pause, but not a failure); a re-attach, and the reload the ladder asked for,
    resume from it, also when playback never got going.
  - While the app is in the background (the plugin observes it), JavaScript is frozen: a reload
    asked for then is held and returned by `resumed()`.
  - On the device: with the stream's server stopped, a 240p switch failed, re-attached, asked for
    a reload, and played on by itself once the server was back.
  - The item's error log feeds the ladder too, as a wedge: an entry counts only while playback is
    stuck waiting for data the viewer asked to see, since AVPlayer also logs failures it gets past.
    On the device the reload came 9 s after play with the server down, where waiting for AVPlayer
    to fail the item took about 100 s.
  - **Open:** the phase 3 conformance scenarios: Android's rungs differ (ExoPlayer retries itself, then `prepare()`), so
    where the shared part sits is to agree with Dirk.
- **Phase 4: the native half built and unit-tested; `live` stays `false`.**
  - `LiveResolver` answers `luminary://live/<n>` with one read per AVPlayer request, ported from
    `resolveLivePlaylist`: `URLSession` with every cache bypassed, LMCENC decrypted with
    CommonCrypto, `key-required` for an AES-128 key with no key URI, then the rewrite.
  - `MediaPlaylistRewrite.swift` ports `rewriteMediaPlaylist` line for line. It splits by UTF-16
    unit, because as Swift characters `\r\n` is one and a CRLF playlist would never split.
  - `AssetStore` keeps live specs by generation, purged with the assets. The router cancels a
    read when AVPlayer cancels the request, finishes a failed read with its code and the upstream
    status, and leaves a released address unanswered. The registry handles `putLive`.
  - Tests port `live.spec.ts` and `rewrite-media.spec.ts` case for case. There are no shared
    fixture files: `player-core/src/test-support/fixtures/` does not exist, so the cases carry
    their playlists, as the TypeScript ones do.
  - `NativeServeStrategy.serveLive` exists only when native reports `live`, and sends `putLive`
    at once, ahead of the load that names it. A failed live read carries its transport error.
  - **Verified in the iOS Simulator** (iOS 26.5) with `live` switched on locally: the Lab's Live
    source (`example-app/scripts/live-stream.sh`, a looping AES-128 stream with a 24 s window,
    served by the dev server at `/live/`) played past 40 s, with the playlist re-read nine times,
    each read successful. Not yet on the iPhone: after a reinstall, iOS blocked the app's native
    requests to the Mac ("Local network prohibited") and neither asked again nor listed the app
    under Local Network, even after a restart. The web view was not blocked.
  - **Open:** a device run once the permission is back, the conformance harness's route result
    (it has no shape for a live answer), and Android's `LiveDataSource`. `live` turns on only when
    both platforms pass.
- **Phase 5: built and unit-tested; `chunkWarming` stays `false`.**
  - `ChunkWarmer` ports `player-web/src/adapter/chunkWarming.ts` and the nine rules of
    `docs/chunk-warming.md`: a 1 s tick on the core's `Clock` reads `max(bufferedEnd,
    currentTime)`, warms the next chunk object within `leadSeconds` with `Range: bytes=0-…`
    through `URLSession`, at most once each, never a chain's first, swallowing every failure, and
    stops once nothing is left. Its tests port `chunkWarming.test.ts` case for case.
  - `PlayerHost` keeps one warmer per load (a reattach keeps it), ignores a call for a load it
    replaced, and stops it on the next load and on destroy.
  - `NativeLuminaryPlayer` no longer turns warming off: whether the adapter warms is native's
    `chunkWarming` capability, as for every other parity-gated feature.
  - In the Simulator, with the capability switched on locally and the forward buffer held to
    5 s: the Sample's `angle0_1.m4s` and `audio_1.m4s` were warmed on the first tick (206, 65 536
    bytes each), and the ticker stopped. Without that limit the 2-minute Sample is buffered whole
    from a local server before the first tick, and there is nothing ahead to warm.
  - **Open:** a run behind a byte-range CDN, where warming earns its keep, and Android's
    `ChunkWarmer.kt`. `chunkWarming` turns on only when both platforms pass.
- **Still to agree with Dirk:** packaging (SwiftPM and a podspec from the same sources).

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

- **AirPlay** was expected to be off for native playback, since a receiver cannot fetch
  `luminary://` playlists. It is on (`airPlay`): tried on a Mac as the receiver, it plays video and
  sound. Not tried on an Apple TV or a speaker.
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
