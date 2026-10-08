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
