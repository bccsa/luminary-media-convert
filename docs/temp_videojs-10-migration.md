# Plan: migrate player-web from Video.js 8 to Video.js 10

## Context

`player-web` is the web engine binding of `player-core`. It runs on Video.js 8.23.4 and VHS 3.17.5. It has two consumers: this repo's `app/`, which uses a bare windowed frame, and the bccsa/luminary app, which installs it from a git submodule. Video.js 8 is in maintenance until 2027. Video.js 10.0.1 has been GA since 2026-10-02, and the goal is to move to it **with no lost functionality and no performance regression**, proven by tests and measurements rather than assumed.

The official migration prompt is written for React. For Vue, the CLI's own rules install **`@videojs/html`**: web components, used from Vue through `isCustomElement` and `.prop` bindings.

### Research findings that shape everything

Sources: the official guides, the `@videojs/html@10.0.1` and `@videojs/hlsjs-video@10.0.1` sources, and `npx @videojs/cli agents init`.

1. **v10 has no VHS.** It offers three HLS paths:
   - `<hlsjs-video>`: hls.js **1.6.7**, pinned by the package.
   - `<hls-video>`: the SPF engine, which accepts no engine config, so it is unusable for us.
   - `<native-hls-video>`.

   Every VHS hook we rely on has to be re-implemented on hls.js. The route exists: `source.engine.hlsJs` is spread into `new Hls(...)` untouched (`hls-js-only.js:32-38`), and `el.engine` exposes the `Hls` instance. The frozen `player-web-old/src/adapter/HlsJsAdapter.ts` already has `createMemoryKeyLoader` (lines 80-115), which can be lifted.
2. **Engine config is read only at construction.** Changing `source.engine` rebuilds hls.js. Our loader config must therefore be a stable object whose closures read the current key or live source.
3. **hlsjs-video ABR defaults differ from ours.** `capRenditionToPlayerSize` defaults to true, with `minAutoResolution` at `'720p'`. VHS is set up with `useDevicePixelRatio` and `enableLowInitialPlaylist`. If these are left at v10's defaults, ABR behaviour changes silently, so both have to be set explicitly to match.
4. **The MSE/native choice:** `useMse = Hls.isSupported() && type is m3u8 && preferPlayback !== 'native'`. A `blob:` master has no `.m3u8` suffix, so `source.type: 'application/vnd.apple.mpegurl'` is mandatory. Without it the source falls through to native playback, which cannot use the memory key.
5. **No plugins.** `videojs-mobile-ui` and `videojs-youtube` go:
   - their gestures are replaced by `<media-gesture>`, `<media-hotkey>` and the orientation-lock feature;
   - YouTube is replaced by `@videojs/youtube-video`.
6. **The Known gaps that apply to us:**
   - Playback rates are fixed at `0.2, 0.5, 0.7, 1, 1.2, 1.5, 1.7, 2`; ours are `[0.5, 0.7, 1, 1.5]`.
   - There is no text-track settings dialog. v8's subs menu offers one.
   - The inactivity timeout cannot be configured. We already run our own `autoHide`.
   - There is no full-window fullscreen fallback. iPhone uses native presentation, as v8 already does there.
   - The rest do not apply to us: ads, playlists, the chapters menu, spatial navigation, runtime theming and debug mode.
7. **Browser floor:** Chrome/Edge 111, Firefox 121, Safari/iOS 16.4. The user has confirmed this is acceptable.

### Decisions (from the user)

- **Skin:** v10's default `video-skin`, restyled through CSS custom properties toward the Luminary look. Eject the skin source only for the controls the default skin cannot express.
- **Workspace:** a new **side-by-side workspace, `player-web-v10`**, with the same props, slots, emits and exposed surface as `player-web`. It is A/B-compared against v8 until parity is proven, then cut over. This follows the earlier player-web-legacy → player-web precedent.
- **Video.js skill:** the user installs it (`claude plugin marketplace add videojs/skills`, then `claude plugin install videojs@videojs`, then `/reload-plugins`). After that, implementation uses the skill plus `node_modules/@videojs/html/docs/llms.txt` as the version-matched docs.

---

## Feature parity register (each row becomes a test)

| # | Feature (today) | v8 implementation | v10 implementation | Risk |
|---|---|---|---|---|
| 1 | In-memory `luminary://key` | `vhsKeyInterceptor` on the xhr seam | hls.js `loader` wrapper (lift `createMemoryKeyLoader` from player-web-old). `keyDelivery: 'memory'` | Low. Proven before |
| 2 | Live playlists `luminary://live/<n>` re-read on every refresh | `vhsLivePlaylistInterceptor` | hls.js `pLoader` that answers `luminary://live/*` via `LivePlaylistSource.resolveLive`, with timeout and abort | Medium. hls.js may reject a non-http scheme in URL resolution, so spike it first |
| 3 | Longer timeout on byte-range segment requests | `vhsRequestTimeout` (10 × targetDuration, 60 s fallback) | `fragLoadPolicy.default.maxTimeToFirstByteMs` / `maxLoadTimeMs` sized the same way, or a `fLoader` that raises the timeout on `context.rangeStart` | Medium. Prove there is no switch-down on a cold chunk |
| 4 | Stall detection → ladder | `vhsStallSignals` (`usage` events) | hls.js `ERROR` events: `BUFFER_STALLED_ERROR`, `BUFFER_NUDGE_ON_STALL`, `BUFFER_SEEK_OVER_HOLE`, fatal network/media. Same "3 within 10 s" wedge rule | Medium |
| 5 | Recovery ladder (rung 0 `recoverInPlace`) | `recover()` returns false | `hls.recoverMediaError()` / `startLoad()` per category (as player-web-old does), so rung 0 gets **better** | Low |
| 6 | `reattach()` (re-source, restore position and play state) | `player.src` | Re-set `el.source` with the same config. Engine rebuilt, restore seek and play | Low |
| 7 | Bandwidth seed / persisted bandwidth | `vhsBandwidthSeed` + `useBandwidthFromLocalStorage` | `abrEwmaDefaultEstimate` read from our own localStorage key, written on `FRAG_LOADED` | Medium. Perf-relevant |
| 8 | ABR start low, DPR-aware | `enableLowInitialPlaylist`, `useDevicePixelRatio` | `startLevel: 0` (or the bandwidth-seeded level); `capRenditionToPlayerSize` chosen to match the VHS DPR cap; `minAutoResolution` set explicitly | Medium |
| 9 | ManagedMediaSource on iOS 17.1+ | `experimentalUseMMS` | hls.js `preferManagedMediaSource` (default true). Check `disableRemotePlayback` handling | Medium. Needs a device |
| 10 | Direct MediaSource attach (Safari) | `vhsDirectSource` | Not needed: hls.js attaches via `src`. Verify on Safari | Low |
| 11 | `load()` guard, source-record and carried-text-track fixes | `guardLoad`, `keepSourceRecorded`, `dropCarriedTextTracks` | Re-test each Safari/iOS scenario they exist for; port only what still reproduces | Medium |
| 12 | Quality list / pinning a variant | `qualityLevels()` | `el.videoRenditions` + quality feature (`selectQuality`), or `hls.currentLevel` | Low |
| 13 | Audio tracks (multi-language, preferredLanguage auto-apply that stops on user override) | `audioTracks()` | `el.audioRenditions` / audio-track feature, `hls.audioTrack` | Low |
| 14 | Subtitle sidecars from blob URLs, menu ↔ controller sync | `addRemoteTextTrack`, `texttrackchange` | `<track>` children / `addTextTrack` on the media element; text-tracks feature store; captions radio group | Low |
| 15 | Chunk warming | `ChunkPrefetcher` + buffered watermark | Unchanged (engine-independent). Watermark from `el.buffered` | Low |
| 16 | Visibility suspend/resume to the ladder | `attachVisibilityListener` | Unchanged | Low |
| 17 | Bare windowed frame (no controls, big play, toggle or dialogs while windowed; no click action; double-click → fullscreen; all controls in fullscreen) | CSS on `.vjs-*` + `bareFrameClick` | CSS on the skin's fullscreen state attribute + `<media-gesture type="doubletap" action="toggleFullscreen">` only. **No tap gesture** while windowed | Medium |
| 18 | Double-click anywhere but on a control toggles fullscreen, in both modes | Own `dblclick` handler with a `.vjs-control…` filter | Own handler kept, with the filter updated to v10 element tags (`media-*-button`, menus, sliders) | Low |
| 19 | Poster `<img srcset sizes>` + fallback chain, goes fullscreen with the picture | Teleported into `player.el()` | Keep our `<img>` inside `<media-container>` (or the `media-poster` slot). Note: v10 `poster` is an attribute only, so ours stays | Low |
| 20 | Audio-only mode: poster + musical-note glyph, black when there is no poster | `audioPosterMode(true)` | Our overlay, plus hiding the `<video>` picture via a CSS class | Low |
| 21 | Coming-soon / error panels and slots | Overlays | Unchanged overlays above `<media-container>`. Suppress v10's `media-error-dialog` | Low |
| 22 | AudioVideoToggle | Controller only | Unchanged; slot it into the restyled skin | Low |
| 23 | Skip back/forward (5/10/30) | `skipButtons` | `<media-seek-button>` with any interval (the 5/10/30 snap becomes unnecessary; keep it so behaviour does not change) | Low |
| 24 | Playback rates `[0.5, 0.7, 1, 1.5]` | `playbackRates` option | **Gap: v10 rates are fixed.** Options: (a) accept v10's 8 rates, (b) a small custom radio group calling `setPlaybackRate`. **Decide in Phase 1.** Default (b) to keep behaviour identical | Gap |
| 25 | Text-track settings dialog (v8 subs menu) | Built-in | **Gap.** Not used by the encoder app. Ask the Luminary app owners; `::cue` styling stays possible | Gap |
| 26 | Auto-hide after 3 s in a full-frame bar | `autoHide.ts` + `userActive(false)` | v10 controls auto-hide is built in, but its timeout cannot be configured. Measure it; if it is not 3 s, keep our timer driving the controls feature | Low |
| 27 | iOS keep-alive silent audio | `keepAlive.ts` | Unchanged (DOM only) | Low |
| 28 | Mobile UI: double-tap seek, rotate-to-fullscreen, orientation lock | `videojs-mobile-ui` | `<media-gesture doubletap seekStep ±10 region=left/right>` + `features.orientationLock`. Rotate-to-fullscreen becomes a small `screen.orientation` listener | Medium |
| 29 | YouTube mode (null controller, media surface still works, error panel when the API fails) | `videojs-youtube` + `youtubeApi.ts` private statics | `<youtube-video>` (`el.engine`, IFrame API). The `youtubeApi.ts` workarounds go, as its own comment already predicted | Medium |
| 30 | YouTube in a non-http page (Capacitor iOS) through the frame protocol | `YoutubeFrameTech` custom tech | **Needs a custom media element**: port `YoutubeFrameTech` to a v10 media adapter (`HTMLVideoAdapter`-style class). Check first whether `<youtube-video>` with the `origin` attribute already works from `capacitor://` | High |
| 31 | Keyboard: transport keys, and the segment editor capturing keys in fullscreen | video.js hotkeys + focus | `<media-hotkey>` scoped to the container (the default). Re-verify `SegmentEditor.vue:1167` capture-phase behaviour against v10 focusables | Medium |
| 32 | Exposed API `{controller, state, enterFullscreen, exitFullscreen, seek, play, pause}`, emits `timeupdate`/`loadedmetadata`/`ended` | Player methods | Player store actions (`requestFullscreen`, `seek`, `play`, …) via `el.store` | Low |
| 33 | i18n of control labels (`messages`) | video.js `languages` | `createI18n` / `registerI18n` translations | Low |
| 34 | App CSS override `.video-js:not(.vjs-fullscreen) .vjs-tech { object-fit: cover }` | `SessionPlayerStrip.vue:599` | A new selector against the v10 DOM; exposed as a documented part/class | Low |
| 35 | Error-code mapping network/media/other | `player.error().code` | hls.js `ErrorTypes` + `el.error` (`MediaError`) | Low |

There are also three behaviours we already have that we must make sure we do not lose by **adding** v10 defaults: v10's `media-error-dialog`, its default hotkeys acting while windowed, and its tap-to-play on a bare frame. Each gets an explicit test.

---

## Architecture of `player-web-v10`

- **Package:** `@luminary-media-converter/player-web-v10`.
- **Dependencies:** `@videojs/html` and `@videojs/hlsjs-video` (installs hls.js 1.6.7), `@videojs/youtube-video`, all pinned exactly to `10.0.1` so one copy resolves in the Luminary app. Peer dependency `vue ^3.5`.
- **Public surface:** identical to `player-web` for `LuminaryPlayer`, `controls.ts`, `image.ts`, `messages.ts`, `usePlayerState`, `BlobServeStrategy`, `RecoveryLadder` and `clock`. These are copied unchanged; the engine-neutral ones are candidates to move into a shared module later, but not in this migration.
- **Engine-specific exports are replaced:** `HlsJsVideoAdapter` instead of `VideoJsAdapter`, plus `installMemoryKeyLoader`, `installLivePlaylistLoader`, `byteRangeLoadPolicy` and `HlsStallSignals`. A test in `exports.test.ts` diffs the export list against v8's, so every removal is deliberate.
- **New `src/adapter/`:**
  - `HlsJsVideoAdapter.ts`: implements `PlayerAdapter` (`player-core/src/types.ts:548-682`) against the `<hlsjs-video>` element and its `engine`.
  - `hlsLoaders.ts`: one stable `HlsConfig` fragment (`loader`, `pLoader`, `fLoader`, `fragLoadPolicy`) whose closures read adapter state.
  - `hlsStallSignals.ts`, `hlsBandwidthSeed.ts`.
  - `chunkWarming.ts` copied unchanged.
- **`src/components/LuminaryPlayer.vue`:**

  ```
  <video-player> → <video-skin> → <hlsjs-video :source.prop>
  ```

  plus `<youtube-video>` in YouTube mode, and our poster, panels, AudioVideoToggle and rate menu as slotted or overlaid children. Custom elements are registered in the library itself, and consumers get a documented `isCustomElement` predicate (`videoJsElements`) to add to their Vite config. The tests check that predicate.
- **`src/styles.css`:** the restyle through `--media-*` custom properties plus targeted part selectors. Ejected skin source is added only for rows 17, 23 and 24 if CSS cannot reach them.
- **Demo:** port `demo/` with an **engine switch (v8 | v10)** that imports both workspaces, so the same source plays A/B on one page. Workspace and root scripts are added to `build:libs`, `ci:libs`, dev watchers and CI.

---

## Phases with exit gates

### Phase 0: baseline before any v10 code

1. Write `docs/temp_videojs-10-migration.md`, a copy of this plan plus the parity register, kept as the working doc.
2. **Test fixtures:** a script (`player-web/e2e/fixtures/build.sh`, using the repo's ffmpeg) that encodes small deterministic outputs through the real API pipeline into a local MinIO, or uses the encoder's output from a fixed source checked into the e2e fixture folder. Fixture variants: clear; AES + LMCENC playlists; byte-range chunk chains; multi-angle + 2 audio languages + subtitles; audio-only; a live-simulated playlist served by a tiny node server that appends segments; a 404/503-injecting proxy for recovery.
3. **Playwright e2e on v8:** projects for Chromium, Firefox, WebKit and Electron (the app's shell), driving the demo. Assert on the behaviour in every parity-register row that a browser can observe.
4. **Perf harness (`player-web/e2e/perf.spec.ts`), the same scripted session per engine:**
   - time to first frame;
   - startup bitrate and time to top rendition;
   - rebuffer count and duration under a throttled CDP profile;
   - bytes downloaded for a fixed watch;
   - seek-to-play latency;
   - JS heap after 10 minutes;
   - long tasks;
   - bundle size (min + gzip) of `dist/` and of `app`'s chunk.

   Record the v8 numbers in the temp doc.

**Gate:** e2e is green on v8 on all projects and the baseline numbers are recorded.

### Phase 1: engine spike (the go/no-go)

Use a throwaway page in the new workspace with only `<hlsjs-video>` and the three loaders. Prove each of these:

- (a) a memory key over a `blob:` master with `type` set;
- (b) `luminary://live/<n>` through `pLoader` with a refresh on every target duration;
- (c) byte-range cold chunk with no switch-down, compared against v8 in the perf harness;
- (d) stall → ladder signal;
- (e) MMS on a real iPhone (iOS 17.1+) and plain native fallback behaviour on iOS 16.4;
- (f) `<youtube-video>` from a `capacitor://` origin (row 30);
- (g) the skin restyle feasibility for rows 17, 23, 24 and 26.

Also decide row 24 (rates) and raise row 25 with the Luminary app owners.

**Gate:** every item is proven, or has a documented workaround the user accepts. If (b), (c) or (e) fails, stop and report before building more.

### Phase 2: adapter

Build `HlsJsVideoAdapter` and its loaders. Port the unit tests:

- `VideoJsAdapter.test.ts` (45 tests) becomes `HlsJsVideoAdapter.test.ts` with a `fakeHlsVideoElement()` helper modelled on `__tests__/helpers.ts:9`;
- the key, live and timeout interceptor tests become loader tests;
- `RecoveryLadder`, `chunkWarming`, `BlobServeStrategy` and `singleFlight` tests are copied verbatim, and must pass unchanged.

### Phase 3: component and skin

Build `LuminaryPlayer.vue` on v10 elements and the restyle. Port every `LuminaryPlayer.*.test.ts`: media, audioOnly, fullscreen, language, serving, mobileUi becomes gestures, youtube, youtubeError, plus `controls` and `poster`. Add tests for the "do not add v10 defaults" behaviours: no error dialog, no tap action on a bare frame, no windowed hotkeys.

### Phase 4: YouTube

Port `<youtube-video>` and the frame-protocol media element (row 30), and delete the `youtubeApi.ts` workarounds.

### Phase 5: parity proof

1. The full Playwright suite runs against v10, with the same specs as Phase 0 parameterised by engine.
2. The perf harness A/B, with these **budgets**:
   - no metric worse than v8 by more than 5% (TTFF, rebuffer, seek), or by more than noise on 5 runs;
   - bundle size not larger than v8's `video.js` + VHS chunk;
   - heap stable.
3. The manual device matrix (the user runs it):
   - iPhone Safari, iPad Safari and Capacitor iOS;
   - Android Chrome and Capacitor Android;
   - macOS Safari;
   - Windows Edge;
   - Electron packaged app.

   Covering: encrypted, multi-angle switch, audio-only, live, lock-screen background audio (suspension-safe), fullscreen in and out, subtitles and YouTube.

**Gate:** all green, budgets met, the user signs off the matrix.

### Phase 6: cutover

1. Point `app/` at `player-web-v10`. Update `SessionPlayerStrip.vue` (the CSS override in row 34, `vite.config.ts` `isCustomElement`) and re-run `app`'s tests, including the segment-editor key capture.
2. Rename the workspaces, following the earlier precedent:
   - `player-web` becomes `player-web-v8`, frozen and outside CI;
   - `player-web-v10` becomes `player-web`.
3. Update the docs:
   - `CLAUDE.md` (player-web description, tech stack, project tree);
   - `README.md:41`;
   - `player-web/README.md`, including consumer instructions for the Luminary app (`isCustomElement`, dependency pins);
   - `docs/suspension-safe-playback.md` (`:10,26,225-271` reference paths);
   - `docs/chunk-warming.md:167-173`;
   - `player-native/temp_native-player-00-overview.md:245`.
4. Delete `docs/temp_videojs-10-migration.md`, or promote the gap register to `docs/` if anything stays open.

---

## Critical files

- **Read and port:**
  - `player-web/src/adapter/*` (`VideoJsAdapter.ts`, the six `vhs*` modules, `chunkWarming.ts`);
  - `player-web/src/components/LuminaryPlayer.vue`, `player-web/src/vjs/*` and `player-web/src/styles.css`;
  - `player-web/__tests__/*`, `player-web/demo/*` and `player-web/src/index.ts`.
- **Reuse:**
  - `player-web-old/src/adapter/HlsJsAdapter.ts` (`createMemoryKeyLoader`, the error mapping, `recoverMediaError`);
  - `player-web/src/drivers/RecoveryLadder.ts` and `clock.ts`;
  - `player-web/src/serve/BlobServeStrategy.ts` (`resolveLive`);
  - `player-core/src/types.ts` (the contract; **unchanged**).
- **Consumers:**
  - `app/src/components/session-view/SessionPlayerStrip.vue`, `app/vite.config.ts` and `app/package.json`;
  - `player-native/example-app/package.json` and `player-native/src/vue/NativeLuminaryPlayer.ts` (prop-parity spec);
  - root `package.json` scripts and `.github/workflows/tests.yml`.

## Verification

1. Run `npm -w player-web-v10 run test` and `npm -w app run test`, plus type-check and build (`npm run build:libs`).
2. Run `npx playwright test` (Chromium, Firefox, WebKit, Electron projects) against both engines; the two must produce identical outcomes.
3. Run `npx playwright test perf` and compare against the recorded v8 baseline in the temp doc.
4. Use `npm -w player-web-v10 run demo` with the engine switch for side-by-side visual checks.
5. Run the `/run` Electron flow on a real encoded session: probe → encode → encrypted playback in the bare frame → fullscreen controls → chapters/subtitles.
6. Run the manual device matrix (Phase 5), with results recorded in the temp doc.

---

## Progress log

### Phase 0: baseline (done, desktop)

- Fixtures: `player-web/e2e/fixtures/build.mjs` (clear, encrypted + LMCENC playlists, byte-range with shared chunk chains). Server: `serve.mjs` (CORS, Range, request log, fault injection by delay/status, a live-stream simulator).
- Playwright: `player-web/playwright.config.ts`, specs in `player-web/e2e/`. `ENGINE=v8|v10 npx playwright test`. Five specs: clear, encrypted (in-memory key, nothing key-shaped on the wire), cold byte-range chunk, live refresh, transient segment failures.
- v8 baseline: 10/10 on Chromium + WebKit. **Firefox does not launch on this machine** (`Could not find profile folder`, an environment problem with Playwright's Firefox build) so Firefox is unverified.
- Not done yet: the perf harness and its recorded v8 numbers.

### Phase 1: engine findings (v10 spike = `player-web-v10/spike`)

- v10 + `HlsJsVideoAdapter` passes the same 5 specs as v8: 10/10 on Chromium + WebKit.
- `@videojs/hlsjs-video` nests its own hls.js 1.6.7 and re-exports `Hls`, so the adapter imports `Hls` from `@videojs/hlsjs-video` and never pins hls.js separately.
- **Cold byte-range chunk (gate c): proven necessary and sufficient.** hls.js's stock `maxTimeToFirstByteMs` (10 s) abandons a 12 s cold chunk and re-requests it after exactly 10 s. The adapter raises it to 60 s (v8's 10 × target-duration backstop). The spec fails when the value is lowered, and passes on v8 and v10 with the raise. An ABR "abandon" after a timeout switched renditions, so an assertion on the retried byte range would have missed it; the spec asserts the gap between the first two requests into the cold object instead.
- **Live (gate b): proven.** A single `Loader` subclass answers `luminary://live/<n>` through `LivePlaylistSource.resolveLive`; the spec fails with that branch removed.
- **Key delivery: proven.** The same `Loader` answers `luminary://key` from memory. A blob master needs `source.type = application/vnd.apple.mpegurl` or v10 hands it to the native path.
- Engine config is read only at construction, and an equivalent `source` object is a no-op. The adapter builds its config once (closures read per-source state) and folds a generation counter into it to force a rebuild for `reattach()`.
- v10 defaults that change behaviour and are overridden to match v8: `capLevelToPlayerSize` (true → false), `capLevelOnFPSDrop` (true → false), `startLevel: 0` for VHS's `enableLowInitialPlaylist`.
- hls.js's gap controller nudges 3 times and then raises a fatal `BUFFER_STALLED_ERROR`, which goes straight into the ladder, so the strike counting in `vhsStallSignals` is not needed.
- Open for Phase 1: iPhone ManagedMediaSource (device), Capacitor YouTube (item f), skin restyle feasibility (item g), the playback-rate decision.

### Component and chrome (done)

- **Skin decision, reversed twice.** The plan said "default skin, restyled". The packaged skin cannot do it: no skip buttons, no way to leave a menu out, no bare windowed frame, 18 built-in hotkeys. First decision: own the skin source. Then: keep the stock skin. Then, once the controls were wanted laid out a specific way: own it after all. **Current: the controls are composed in `src/ui/controlsHtml.ts` from v10's `media-*` elements**, with the default skin's stylesheet still drawing the buttons, icons, menus and sliders and `src/styles.css` placing and restyling them.
- **Layout as asked for:** pause/play centred with skip back/forward flanking it; thick rounded timeline with no thumb, on its own row with wide side insets (these controls are mostly met in fullscreen, where a stray edge touch must not seek); under it volume (a card: plus, thick vertical slider, minus) then quality, language, speed, captions, each its own button opening its own card; casting, AirPlay, picture-in-picture and fullscreen together on the right. No cogwheel, no top-left cluster. No blur anywhere (custom properties set to none). The audio/video toggle is gone from the player.
- **Sizes follow the player's width, not "mobile vs desktop":** every size is a multiple of `--lmpl-s`, stepped by container query at 900 px and 1400 px. The first attempt put the side-inset on `.lmpl-root`, which is the *parent* of the size container, so the query never applied and a 2000 px screen kept a phone's margin. Caught from a screenshot; the spec now asserts it.
- **3 s auto-hide** (v10 hard-codes 2 s): holds a controls lock while the pointer is active, releases it and hides at once at 3 s.
- **Scrub thumbnails** from `player-core` (`source.sidecars.thumbnails`, `thumbnailsReady`, `thumbnailAt`): the frame under the pointer with its timecode, following the pointer and kept inside the frame, staying up through a drag, nudged off the very end so the last position does not blank, holding the last frame across a gap in the cues. Same look as `player-web-old`'s `ScrubThumbnail`, which is the reference for a native player. Works for an encrypted session (LMCENC `thumbnails.vtt`, plain sprite).
- **Language selector:** shown only when the stream has more than one language (v10 hides the trigger itself otherwise). Switching works, but needed a fix: `<hlsjs-video>` builds new track lists with each engine and has none before one exists, so listeners bound once at mount never attached, and a language picked in the card reached the engine but not the controller.
- **Bugs found by looking, not by tests:** the skip buttons were inert (`media-seek-button` is not registered by the default skin, which seeks by gesture); the vertical volume fill covered half the track (the skin sets `left: 0` for a horizontal fill's pseudo-element only); a 22 px gap between volume and the settings.
- **A test-infrastructure finding:** the tests and a browser tab on the same fixture server disturb each other (armed faults, the live clock reset). The tests now have their own on port 5191 (`FIXTURE_PORT`).
- **Real multi-language media:** `player-native/spike/.../stream` (two angles, English/Español/Français/Deutsch, AES-128, byte-range chains) is served at `/native/` by the fixture server, key `6c756d696e6172792d737069a4e2c0de`.

### Open, and cross-player

- **Native plan 05 specifies the native fullscreen controls as a copy of the Video.js 8 look** (icons exported from video.js's font, a screenshot of each web state). The v10 layout departs from that. Needs a decision: native follows the new web look, or the web look follows native. Not decided here.
- **Native has no scrub thumbnails.** The data path is player-core's (`thumbnailsReady`, `thumbnailAt`), so native only has to draw it; the geometry rules (nudge off the end, clamp inside the frame, hold the last frame) are written down in `src/ui/scrubPreview.ts` and tested.
- Live: v8 hid the skip buttons and the speed control on a live stream. Not done in v10.
- Audio-only artwork layer, YouTube mode, `windowedControls: false` on a real device, iOS ManagedMediaSource, Firefox, performance numbers: still unverified or undone.

### Size (done)

| | Before | After |
|---|---|---|
| The library file (`dist/index.js`) | 153 kB, 30.2 kB gzipped | 83.7 kB, 21.3 kB gzipped |
| An app using the player (Vue left out) | about 1.3 MB, about 320 kB gzipped | 848 kB, 251 kB gzipped, of which hls.js is 500 kB |

Where it came from, in the order it mattered:

- **Importing the packaged skin (`@videojs/html/video/skin`) cost an app 553 kB (120 kB gzipped)**: every UI element Video.js has, every icon, and the skin's own template and 97 kB stylesheet, none of it drawn here. `src/ui/register.ts` now imports the 33 elements and 19 icons the controls use, one module each.
- **The skin's stylesheet** is trimmed at build time (`scripts/build-skin-css.mjs`, PurgeCSS): rules for other themes and presets dropped, the `[data-theme]` / `[data-preset]` attributes stripped from the selectors (inside `:where()`, so specificity is unchanged), unused rules removed, then minified. 96.8 kB to 32.2 kB, written to `src/generated/skin.css` (not committed; the `build`, `build:lib`, `demo` and `dev` scripts regenerate it).
- **The library output is minified** (esbuild, in `generateBundle`, after Vite's own pass, which otherwise reprints it with its whitespace). Cost: ten `/* @__PURE__ */` annotations, which no esbuild minify keeps.
- **Not done:** hls.js is 59% of an app's bundle and cannot shrink while the player is built on it; `hls.js/light` lacks alternate audio, which this player needs. Loading it on demand would move it out of an app's first load, but it is the app's route-level splitting that decides that, and the adapter imports `Hls` statically.

**A near-miss worth knowing:** the first version of the minimal registration was dropped entirely from the built library. `register.ts` has no exports, this package declares only `.css` and `.vue` files as having side effects, so the bundler removed the import: the built player registered not one control. Every test passed, because they all drive the demo, which loads source. Fixed by declaring `**/ui/register.ts` in `sideEffects`, and caught for good by `e2e/built.spec.ts`, which mounts the player from `dist/` (`demo/built.html`) and checks that every tag is registered, every icon draws, the stylesheet applies, an encrypted stream plays and the controls work. With the fix removed, four of its five specs fail. `npm -w player-web-v10 run build:lib` before running it; the Playwright config does.

**Pixel guard:** `e2e/visual-guard.spec.ts` (a local tool, `SNAPSHOT_DIR=…`) compares 13 states of the controls with the picture masked. The trimmed stylesheet and the minimal registration are pixel-identical to the full ones on all 13.

Localisation: the setting buttons' hidden labels were `<media-text token=…>`, which needs an element this package does not expose by a public path; they are plain spans with English text now, like the card titles.

### hls.js size: the light build does not work, a custom build does (not adopted)

hls.js is 500 kB of the 848 kB an app ships (59%). Measured, on hls.js 1.6.7, which `@videojs/hlsjs-video` pins:

- **`hls.js/light` plays every picture and no sound.** It stubs out alternate audio, and every audio group this encoder writes is an alternate-audio `#EXT-X-MEDIA` playlist, even with one language. On all three test streams: 0 audio tracks, 0 bytes of audio decoded, no error, lifecycle "ready". The full build decodes audio on all three. It saves 178 kB (51 kB gzipped) by dropping features this player needs. Do not use it.
- **A custom compile is possible.** hls.js has nine compile-time switches (`__USE_ALT_AUDIO__`, `_SUBTITLES__`, `_EME_DRM__`, `_CMCD__`, `_INTERSTITIALS__`, `_CONTENT_STEERING__`, `_VARIABLE_SUBSTITUTION__`, `_M2TS_ADVANCED_CODECS__`, `_MEDIA_CAPABILITIES__`). Compiled from `hls.js/src/hls.ts` with esbuild, alternate audio on and the rest off: **345 kB (109 kB gzipped) against 489 kB (153 kB gzipped) for the same compile with everything on**, 144 kB (43 kB gzipped) less, about 17% of an app's bundle. The whole suite (88 browser checks, Chromium and WebKit) passes against it, including the four-language stream, live, byte-range and encrypted playback.
- **Why it was not adopted:** it means owning a build of a dependency pinned inside Video.js (it needs `@svta/common-media-library` 0.15.1, `eventemitter3` 5.0.1 and `url-toolkit` 2.2.5, which hls.js bundles rather than lists, and must be redone on every Video.js bump), and an app has to alias `hls.js` to it, which a library cannot do for its host. It would also drop DRM, in-stream WebVTT subtitles and CMCD, none of which are used here today. To redo it: the switches above, `define` them in an esbuild of that entry, alias `hls.js` in the app's bundler.
- **A test gap this exposed:** nearly every check read the playhead, which advances for a silent video. `playback.spec.ts` now reads the browser's decoded audio and video byte counts for three streams (Chromium; WebKit does not report them). It fails on all three under the light build and passes on the full one, on both players.
