# Native player: overview and roadmap

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

Working document for the native (Capacitor) player effort. Delete it, or move its
lasting parts into a permanent doc, once the plans below have landed.

## The goal

One player architecture for web, iOS and Android that does not drift apart.
`player-core` is the shared centre: it prepares playlists (munging), owns the
state store, coming-soon polling and chapters, and drives an engine through
`PlayerAdapter` / `ServeStrategy` (`player-core/src/types.ts`). The web player
(`player-web`, Video.js 8 today) is one engine. AVPlayer and ExoPlayer are the
other two, behind one Capacitor plugin, `player-native`.

`docs/suspension-safe-playback.md` sets the rule every native engine follows.
Anything that must keep working while JavaScript is frozen (a locked phone) runs
next to the engine: key delivery, recovery, chunk warming, the live refresh.
Only rebuilding a munged source goes back to `player-core`.

## The plans, and who works on what

| Plan | Owner | Starts |
|---|---|---|
| [01 — Bridge](temp_native-player-01-bridge.md) | Johan | now |
| [02 — Android](temp_native-player-02-android.md) | Dirk | step 0 now; the rest once the bridge's gate is met |
| [03 — iOS](temp_native-player-03-ios.md) | Johan | step 0 now; the rest once the bridge's gate is met |
| [04 — Conformance tests](temp_native-player-04-conformance.md) | Dirk | as soon as the `bridge.ts` draft exists |

- **The bridge** (01) is the contract and its JavaScript side: `bridge.ts`, the
  TypeScript half joined to `player-core`, and the plugin package scaffold.
- **The platform plans** (02, 03) build everything behind the contract on the
  device: the native structure described below, then the real engine, then the
  later phases.
- **The conformance plan** (04) turns the contract into shared test scenarios,
  and builds the runners that replay them in TypeScript, Kotlin and Swift. Those
  runners are how the platforms are kept consistent.

**The gate for the platform plans:** `bridge.ts` is frozen at protocol v1, and the
TypeScript half is built. Plan 04's v1 scenarios pass against the TypeScript half.

## Native structure (both platforms, the same names file for file)

Plans 02 and 03 both implement this, so the Swift and Kotlin trees can be read
side by side. Only the `Engine` implementations touch AVFoundation or Media3.

```
LuminaryPlayerPlugin   decode + validate → main thread → PlayerRegistry; reject with the bridge's codes; no engine code
BridgeTypes            Codable (Swift) / data classes (Kotlin), mirroring bridge.ts by hand
PlayerRegistry         create / reset / lookup; maxPlayers 1 (a second create destroys the first)
PlayerHost             one AssetStore, KeyHolder, UriRouter, Engine, EventSink; applies load
                       (assets → key → engine.load); purges released generations after the swap;
                       audio-track empty-then-list rule; suspend / resume; holds pendingReload
AssetStore             generation → uri → (bytes, contentType); thread-safe; whole-generation swap
KeyHolder              16 bytes; zeroed on destroy / replace; never logged
UriRouter              the bridge's URI scheme. iOS: AVAssetResourceLoaderDelegate on its own queue.
                       Android: HlsDataSourceFactory → routing DataSource per open(), by URI, never by
                       dataType; in-memory sources isNetwork = false
EventSink              stamps playerId / loadId; enforces the emission rules (4 Hz / 1 Hz); silent after destroy
Engine                 the only AVFoundation / Media3 seam (below)
```

```kotlin
interface Engine {
    fun load(masterUri: String, startPosition: Double?)
    fun reattach()                                   // same assets; restore position, rate, tracks
    fun play(); fun pause()
    fun seek(position: Double, exact: Boolean)
    fun setRate(rate: Double)
    fun setVariant(id: String)                       // "auto" clears; only if variantSwitching
    fun setAudioTrack(id: String)
    fun snapshot(): Snapshot
    fun enterFullscreen(); fun exitFullscreen()
    fun destroy()
    var events: EventSink                            // the only outbound path
}
```

```swift
protocol Engine: AnyObject {
    func load(masterUri: URL, startPosition: Double?)
    func reattach()
    func play(); func pause()
    func seek(position: Double, exact: Bool)
    func setRate(_ rate: Double)
    func setVariant(_ id: String)
    func setAudioTrack(_ id: String)
    func snapshot() -> Snapshot
    func enterFullscreen(); func exitFullscreen()
    func destroy()
    var events: EventSink { get set }
}
```

Changing this structure or the `Engine` interface is agreed between Dirk and
Johan and applied to both platforms in the same change, just like `bridge.ts`.

## Decisions already made

- **One plugin.** `player-native/` holds `src/` (TypeScript), `ios/` (Swift),
  `android/` (Kotlin), `conformance/` and `example-app/`.
- **Full-screen first on both platforms.** The host already draws a poster in
  its player slot (`VideoPlayer.vue` in `bccsa/luminary`). The native component
  adds a play button and presents native full-screen. Inline native video is
  deferred on both platforms: the slot says *where* the picture goes, but not how
  a native view tracks a scrolling WebView, or how HTML draws over it.
- **YouTube plays in `player-web`, on every platform.** No native YouTube code.
- **The platform is chosen in the host,** through a `virtual:video-player`
  build-time seam, following `bccsa/luminary`'s existing `buildTargetVirtuals.ts`
  / `VITE_NATIVE_IMPL_DIR` pattern. `player-core` gains no platform layer.
- **Live is built on both platforms.** The resolver ports are tested against
  fixtures read from `player-core`.
- **`renderText` (side-loaded VTT subtitles) stays false on both for now.**
  Subtitle groups inside the master render natively on both.
- **Protocol choices:** a JS-created `loadId` plus `playerId`; assets inline in
  `load`, plus `putAssets` for VTTs that arrive later; one scheme,
  `luminary://asset | live | key`; `seek { position, exact? }`;
  `nowPlaying { title, subtitle?, artworkUrl? }`; events at 4 Hz / 1 Hz;
  `detail: { code, message }` on errors; `activeId` on audio tracks;
  capabilities from `getInfo()`; one engine-agnostic `NativeBridgeAdapter`.
- **`player-core` change, approved:** the controller honours
  `capabilities.variantSwitching` / `renderText` (see *Other work* below).

## Parity rules (every plan follows these)

1. **One protocol file.** A change to `bridge.ts` bumps `PROTOCOL_VERSION` if it
   breaks anything. It updates both `BridgeTypes` mirrors and a plan 04 scenario
   in the same PR.
2. **Parity-gated capabilities** (`renderText`, `live`, `chunkWarming`,
   `backgroundAudio`) turn on only when **both** platforms pass their scenarios.
   Only the engine-inherent ones (`variantSwitching`, `pictureInPicture`) may
   differ between platforms.
3. **No platform branches in TypeScript.** Differences arrive only through
   `getInfo().capabilities`.
4. **Same names on both sides, file for file** (the native structure above), with
   the emission rules the bridge plan defines.

## Phases (each ships on both platforms together)

| Phase | Content | Where it is planned |
|---|---|---|
| 1 | Bridge: contract, TypeScript half, plugin scaffold | 01 |
| 1 | Conformance: scenarios and runners in TypeScript, Kotlin and Swift | 04 |
| 1a | Native structure on each platform, passing the conformance scenarios with a `FakeEngine` | 02, 03 |
| 1b | Minimal `Engine` binding: plays an encrypted VOD end to end | 02, 03 |
| 2 | Presentation: native full-screen presenter; `NativeLuminaryPlayer.vue` (same props / emits / expose as `player-web`'s `LuminaryPlayer`); the host's `virtual:video-player` | 02 / 03 (presenter); component and host seam: see *Other work* |
| 3 | The recovery obligation: engine primitive → `reattach` → held `reload-requested`; `stalled` | 02, 03 |
| 3b | Background: audio / media session, lock screen, interruptions; `backgroundAudio` | 02, 03 |
| 4 | Live resolver; `live` | 01 (`serveLive`), 04 (fixtures), 02, 03 |
| 5 | Chunk warming; `chunkWarming` | 02, 03 |
| 6 | Side-loaded subtitles, inline native video, casting / AirPlay | later |

## Reference paths (as of `f3839f3`)

`player-web-legacy` became `player-web` in `acfa25c`. The frozen hls.js player is
`player-web-old` and is never cited.

- The recovery ladder: `player-web/src/drivers/RecoveryLadder.ts`, `drivers/clock.ts`.
- Chunk warming: `player-web/src/adapter/chunkWarming.ts`, with the normative
  spec in `docs/chunk-warming.md` (nine rules).
- The web serving layer: `player-web/src/serve/BlobServeStrategy.ts`, and
  `serve/livePlaylistUri.ts` (`LIVE_PLAYLIST_URI_PREFIX = 'luminary://live/'`).
- The live refresh on the web: `player-web/src/adapter/vhsLivePlaylistInterceptor.ts`;
  in `player-core`: `resolveLivePlaylist` in `player-core/src/policy/live.ts`.
- The public surface of the web component, which the native component matches:
  `player-web/src/components/LuminaryPlayer.vue`. Events
  `timeupdate(currentTime, duration)`, `loadedmetadata`, `ended`; exposes
  `controller, state, enterFullscreen, exitFullscreen, seek, play, pause`.
  Controls: `skipBackSeconds` / `skipForwardSeconds` (default 10).

## Recorded conflicts with the original iOS design

The original iOS design ("AVPlayer plugin design") predates #239. Plan 03 carries
the changes that follow from it:

- Recovery belongs to the adapter. `player-core` has no retry logic, and a fatal
  `error` ends playback (`types.ts:427–435`).
- `reattach()` is a required method (`types.ts:546`).
- The resume re-emit and the held reload were missing.
- The audio-track rule (`types.ts:560`).
- Content types per asset. Served VTTs were labelled as playlists.
- The rationale for skipping chunk warming was wrong: warming primes the CDN
  edge, not the player's buffer.
- Its `sessionId` (a per-load id) is replaced by a JS-created `loadId`.

## Edge-case catalogue (for all plans)

- **Payload size.** Every media playlist of the narrowed master is sent at
  `load()`, once per source; later munges reuse the served URLs. Encrypted
  sessions with subtitles add the decrypted VTT segments. Text goes as text,
  never base64. Measure on a 2-hour, wide-ladder source.
- **The key crosses the bridge.** Turn Capacitor's `loggingBehavior` off in
  release builds, and never log `load` natively. The level of obscurity matches
  the masked key over HTTP; this is not DRM.
- **CORS.** `player-core` fetches playlists from the WebView origin
  (`capacitor://localhost` on iOS, `https://localhost` on Android), so the
  bucket's CORS rules must allow both. `http://` MinIO exceptions belong in
  `example-app` only.
- **Renderer death, WebView reload, HMR.** `reset()` at module start destroys
  orphaned native players.
- **Version skew between the app and the plugin.** `getInfo().protocolVersion`.
- **Plugin install.** `bccsa/luminary` consumes the player packages through a
  submodule plus a `file:` install, and `npx cap sync` must find `ios/` and
  `android/` through it. Test this early.
- **AirPlay and casting** cannot fetch `luminary://`, so they are off for native
  playback.
- **Cold chunks.** Check every platform's per-request timeout and ABR reaction
  against a cold byte-range chunk (`docs/suspension-safe-playback.md`, the
  "caution" section).

## Other work, not yet assigned to a plan

- **The capability-flag change in `player-core` (approved).**
  - Today `PlayerController` never reads `capabilities.variantSwitching` or
    `renderText`. With `getVariants()` empty, as it is on AVPlayer,
    `refreshQualities` (`player-core/src/controller.ts:662`) keeps the munged list,
    and `setQuality` cannot act on it.
  - The change: when `!variantSwitching`, `setQuality(id)` reloads through the
    existing munge with that height as the load-time `maxHeight` (keeping position
    and play state), and `'auto'` removes the cap. When `!renderText`, side-loaded
    subtitle tracks are left out of `subtitleTracks`, and `setTextTracks` is not
    called.
  - Specs go in `controller.spec.ts`. The `player-web` owner reviews it.
  - It is needed before iOS offers a quality menu (phase 2).
- **Phase 2 host surface.**
  - `NativeLuminaryPlayer.vue`, with the same props, emits and expose as
    `player-web`'s `LuminaryPlayer`. It draws a play button over the host's poster
    in `VideoPlayer.vue`'s slot, then calls `enterFullscreen`.
  - The host's `virtual:video-player` in `bccsa/luminary`: a contract, a web
    plugin wrapping `player-web`, the name added to `platformSwappable`, and a
    native file in `luminary-deployment/capacitor/native-plugins/`.

## Cross-team items (with the `player-web` owner)

- **The capability-flag change** in `PlayerController` (bridge plan) needs their
  review.
- **Fixtures move into JSON** under `player-core/src/test-support/fixtures/`
  (phase 4, plan 04). Test-only.
- **`audioTrackLanguage.ts` moves** (`preferredLanguage` matching) from
  `player-web` into `player-core`, so the native component picks languages the
  same way (phase 2).
- **Video.js 10 has not landed** (8.23.4 at `f3839f3`). When it does, recheck the
  reference paths and the YouTube path.
