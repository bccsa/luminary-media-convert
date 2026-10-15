# Plan 04: Conformance tests

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

**Owner:** Dirk.

**Depends on:** the `bridge.ts` draft from [plan 01](temp_native-player-01-bridge.md).
It can start as soon as that draft exists.

**Used by:** plan 01 (the TypeScript half), plan 02 (Android) and plan 03 (iOS).

## Status (2026-09-29)

Built. The normative description of the format, the harness, `FakeEngine` and
the emission rules is now [`conformance/README.md`](conformance/README.md). This
plan keeps only the decisions and what is left.

- **Scenarios:** 16 v1 files (`conformance/01…16-*.json`). There are two
  beyond the list below: `15` (a second `create` replaces the first) and `16`
  (validation, and the order of rejection checks).
- **Runners:** Vitest runs the TS side, and the native side against a
  **reference native side** in TypeScript (`src/test-support/conformance/reference/`).
  That reference proves every scenario can be satisfied, and is the model the
  platforms port. JUnit (`android/`, `./gradlew test`) and Swift Testing
  (`Package.swift`, `swift test`) run the native side against
  `makeConformanceHarness()`.
- **Runner parity:** the reference side's conversation with the runner is
  recorded per scenario (`conformance/selftest/transcripts/`, refreshed by
  `npm -w player-native run conformance:transcripts`). The Kotlin and Swift
  runners replay every scenario against it, so all three runners drive a
  harness identically. The ref and matcher rules share
  `conformance/selftest/match-cases.json`.
- **No skipping:** until phase 1a makes `makeConformanceHarness()` return a
  harness, each native scenario **fails**. This was decided so the platforms are
  held to the scenarios from their first commit.
- **CI:** `player-native` joins the Vitest matrix. There are two new jobs,
  `Conformance (Android)` and `Conformance (iOS)`, each with a runner step
  (green) and a scenarios step (red until phase 1a).
- **Scaffolding done here:** the Android plugin module (`android/build.gradle`,
  Gradle 9.1 wrapper, AGP 8.13, Kotlin 2.2, Java 21, package
  `org.bccsa.luminary.player`) and a root `Package.swift` holding only the
  `Conformance` test target. **Plan 03 adds the plugin target to it.**

### Changes from the draft below

- `reject` folded into `call.rejects`. On a native call it asserts the
  rejection; the TS fake answers with it.
- `call.match` added: a TS-only matcher for `load`, whose real munged assets
  cannot equal the concrete ones native must be sent.
- Step kinds added: `expectEngine` (native), `expectState` and
  `expectNoCalls` (TS). Any step can carry `only`. Matchers: `$absent`,
  `$any`, `$prefix`, `$length`, `$each`, `$contains`, `$not`.
- The harness gained `drainEngineCalls()`, and `start` takes the capabilities
  as JSON. **Agree both with Johan.**
- Scenario 12's held `reload-requested` is pinned on the TS side only. Natively,
  a held reload needs the recovery ladder, so it belongs to the phase 3
  scenarios.
- Emission rules the bridge left open, now fixed in the README:
  - no event before a player's first load;
  - the `timeupdate` period restarts on a seek;
  - `progress` holds the latest value and releases it when the window ends;
  - `variants-updated` only when `variantSwitching`;
  - the rejection order: capability → arguments → player → generation.

### Left to do

- Phase 1a (plans 02 / 03): `PlayerRegistry` on a `FakeEngine` behind
  `makeConformanceHarness()`, ported from the reference side.
- Agree the harness additions above with Johan.
- Fixtures for the live port (phase 4) and the later-phase scenarios.

---

These scenarios are the executable form of the bridge contract, and they are what
keeps the two platforms consistent (see the parity rules in
[the overview](temp_native-player-00-overview.md)). This plan owns:

- the scenario format and files;
- the three runners (Vitest, JUnit, XCTest);
- the test seam each platform must expose;
- the shared fixtures for the live port;
- the CI wiring.

## The scenario format (`player-native/conformance/*.json`)

A scenario describes **the wire**: the calls JS makes to native, and the events
native sends back. The TypeScript half and each native side sit on opposite ends
of that wire, so every step is marked with the side(s) it applies to. Each runner
skips the steps that aren't its own.

```jsonc
{
  "name": "angle switch reuses the generation",
  "capabilities": { "variantSwitching": true },   // overrides the FakeEngine / fake plugin defaults
  "steps": [
    { "drive":  { "controller": "load", "args": { /* PlayerSource */ } } },            // TS only: act on PlayerController
    { "call":   { "method": "load", "args": { /* LoadArgs, match: subset */ } } },     // TS: assert issued · native: issue it
    { "engine": { "signal": "readyToPlay", "duration": 120 } },                        // native only: FakeEngine signal
    { "event":  { "name": "durationchange", "payload": { "duration": 120 } } },         // TS: inject · native: assert emitted
    { "advanceClock": 1.0 },                                                           // both: virtual clock
    { "expectNoEvents": true },                                                        // native only
    { "expectAdapter": { "getDuration": 120 } },                                       // TS only
    { "route":  { "uri": "luminary://key", "expect": { "bytes": 16 } } },              // native only: through UriRouter
    { "reject": { "method": "setVariant", "code": "unsupported" } }                    // TS: fake rejects · native: assert rejected
  ]
}
```

- **Matching** is by subset: an expected payload lists the fields that matter.
  Ids (`playerId`, `loadId`) match by *reference*: `"$load1"` binds on first use
  and must match afterwards. So both sides can create real ids and still be
  checked.
- **Time is virtual.** Throttling rules (4 Hz / 1 Hz) are checked with
  `advanceClock`. That requires the clock seam below.
- **Engine signals** are a small shared vocabulary that `FakeEngine` understands
  on both platforms: `readyToPlay`, `playing`, `paused`, `buffering`, `seeked`,
  `ended`, `tracks`, `variants`, `failed`, `bufferedTo`, `position`. Adding a
  signal is a change to this plan.

## The test seam each platform exposes (implemented in plans 02 / 03)

Both platforms provide the same harness, in their own language:

```kotlin
interface ConformanceHarness {
    fun start(capabilities: BridgeCapabilities)             // PlayerRegistry wired to FakeEngine + a virtual clock
    fun call(method: String, args: JsonObject): CallResult  // same decode path as the plugin: resolve(json) | reject(code)
    fun engine(signal: String, args: JsonObject)            // drives the current FakeEngine
    fun advanceClock(seconds: Double)
    fun drainEvents(): List<JsonObject>                     // what EventSink emitted, in order
    fun route(uri: String): RouteResult                     // through UriRouter: bytes + contentType | error code
}
```

The Swift version has the same members.

- **`call`** must go through the same decoding and validation as
  `LuminaryPlayerPlugin`, without the Capacitor call object. Otherwise the runner
  tests something the app doesn't run.
- **`EventSink` and `PlayerHost` take an injectable clock.** Plans 02 and 03 build
  them that way.

## The runners

| Runner | Where | Drives |
|---|---|---|
| Vitest | `player-native/src/conformance.spec.ts` (`npm -w player-native test`) | `NativeBridgeAdapter` + `NativeServeStrategy` + a real `PlayerController`, over a fake plugin that asserts `call` steps and injects `event` steps. Uses `player-core/src/test-support` (`makeFetch`, `SIMPLE_MASTER`, `MULTI_ANGLE_MASTER`, `ENCRYPTED_MEDIA_PLAYLIST`, `TEST_KEY_HEX`) for `drive` steps |
| JUnit | `player-native/android/src/test/…/ConformanceTest.kt` (`./gradlew test`) | The Kotlin `ConformanceHarness`; one parameterized test per scenario file |
| XCTest | `player-native/ios/Tests/ConformanceTests.swift` (`xcodebuild test`) | The Swift `ConformanceHarness`; one test per scenario file |

All three read `player-native/conformance/*.json` by relative path. There are no
copies.

## v1 scenarios

1. `getInfo` with a mismatched version → the adapter refuses to start with
   `protocol-mismatch`.
2. `reset` destroys players left behind by an earlier JS context.
3. `create` → `load` → `play`: the event order and the stamped ids.
4. An angle switch in the same generation sends only a new master, and evicts
   nothing.
5. Events carrying a stale `loadId` are dropped by the adapter.
6. The audio-track rule: an empty list on `load` / `reattach`, then the list;
   `setAudioTrack` is ignored in between.
7. `releaseAssets` purges only after the next item has taken over.
8. Routing: an asset (bytes and `contentType`), the key (exactly 16 bytes), a
   missing asset (not-found), a missing key (`key-required`).
9. The key is zeroed on `destroy` (the route fails afterwards).
10. `setVariant` / `putLive` / `warmChunks` → `unsupported` when the capability is
    false.
11. Throttling: `timeupdate` at most 4 Hz while playing, plus once on seek and once
    on pause; `progress` at most 1 Hz.
12. `resumed()` returns the snapshot, and any `reload-requested` held while
    suspended.
13. `destroy` twice is safe; there are no events after `destroy`.
14. `exitFullscreen` pauses, except for audio-only.

Later phases add scenarios as their capabilities arrive. A capability flips only
when both native runners pass its scenarios:

- **phase 3:** the recovery order (an in-place attempt → `reattach` →
  `reload-requested` → a fatal `error`), and the held reload on resume;
- **phase 4:** live routing, a released live address never being answered, and
  `key-required` on a mid-stream key;
- **phase 5:** the warming rules in `docs/chunk-warming.md`.

## Shared fixtures for the live port (phase 4)

- Move the cases `player-core`'s specs already use (live, `rewriteMediaPlaylist`,
  `scanMediaPlaylist`, LMCENC) into JSON under
  `player-core/src/test-support/fixtures/`.
- `player-core`'s own specs then read those files. Their assertions stay
  unchanged, which proves the move changed nothing.
- The Kotlin and Swift live-resolver tests read the same files by path.
- This is test-only, and the `player-web` owner reviews it.

## CI

- **Vitest:** `npm -w player-native test` joins the existing `tests.yml` job, next
  to the other workspaces.
- **JUnit:** a Gradle job on Linux.
- **XCTest:** an `xcodebuild test` job on a macOS runner.
- **Parity check:** a PR that changes `bridge.ts`, `conformance/`, or either
  platform's `BridgeTypes` must pass all three runners.

## Build order

1. Write the scenario format and the `ConformanceHarness` definition. Agree the
   harness with Johan (bridge / iOS) before either platform builds it.
2. Write the v1 scenarios against the `bridge.ts` draft.
3. Build the Vitest runner, and run it against plan 01's TypeScript half before
   the freeze.
4. Build the JUnit runner alongside plan 02's phase 1a, and the XCTest runner
   alongside plan 03's phase 1a.
5. Add the three CI jobs.

## Verification

- All three runners discover the same number of scenario files, and pass every one.
- A deliberately broken scenario fails in all three runners. This proves that each
  runner reads the shared files, not a local copy.
- `npm run build:libs` and the existing workspace tests still pass.
