# Bridge conformance scenarios

These files are the executable form of the native bridge contract
(`../src/bridge.ts`). Three runners replay them:

| Runner | Side | Drives | Where |
|---|---|---|---|
| Vitest | TS | `NativeBridgeAdapter` + `NativeServeStrategy` + a real `PlayerController`, over a fake plugin | `src/conformance.spec.ts` |
| Vitest | native | the **reference native side**, in TypeScript | `src/conformance.reference.spec.ts` |
| JUnit | native | the Kotlin `ConformanceHarness` (a `PlayerRegistry` on a `FakeEngine`) | `android/src/test/java/…/conformance/` |
| Swift Testing | native | the Swift `ConformanceHarness` (the same, in Swift) | `ios/Tests/Conformance/` |

Every runner reads the JSON files in this directory by relative path. Nothing
is copied. A scenario that passes on one side and not the other is a parity
break, and a capability does not turn on until every runner passes its
scenarios.

- **The reference native side** (`src/test-support/conformance/reference/`) is
  `PlayerRegistry`, `PlayerHost`, `AssetStore`, `KeyHolder`, `UriRouter`,
  `EventSink`, `FakeEngine` and a virtual clock, with the names of the native
  structure. It proves every scenario can be satisfied before either platform
  runs it. It is also the model the Kotlin and Swift trees port. When a
  platform and the reference disagree, the scenario decides.
- **A platform without a harness fails every scenario.** It does not skip them.
  `makeConformanceHarness()` returns null until phase 1a wires it up, and until
  then each scenario fails with "No ConformanceHarness".
- **`selftest/match-cases.json`** holds the shared cases for the ref and matcher
  rules below. Each runner's port of those rules passes them, and each runner
  also has self-tests showing that it fails a conversation that does not match.

## A scenario

```jsonc
{
    "name": "angle switch reuses the generation",
    "capabilities": { "variantSwitching": true },   // optional; overrides the defaults on both sides
    "fetch": { "https://cdn/master.m3u8": "@SIMPLE_MASTER" }, // TS only: the controller's fetch
    "steps": [ /* … */ ]
}
```

- **`capabilities`** is a partial `BridgeCapabilities`. The defaults are all
  `false`, with `maxPlayers: 1`. The TS fake plugin reports them from `getInfo`,
  and the native harness is started with them.
- **`fetch`** maps URLs to bodies for the controller's `fetchImpl`. `@NAME`
  names a string export of `player-core/src/test-support`. Native runners ignore
  it.

A scenario describes **the wire**: the calls JavaScript makes to native, and the
events native sends back. The two halves sit at opposite ends of it, so the
same step means different things on each side.

## Steps

Each step has exactly one kind key. It may also carry `"only": "ts" | "native"`
to narrow it to one side (only to a side the kind has meaning on), and a
`"note"` for the reader.

| Step | TS runner | Native runner |
|---|---|---|
| `drive` | Acts: `{ "start": {…} }` calls `createNativePlayer`; `{ "controller": "load", "args": … }` or `{ "adapter": "resume" }` calls that method (an array is positional arguments, anything else is the one argument) | — |
| `call` | Asserts that the next call the plugin received is `method`, with args matching `match` (or else `args`); the plugin answered it with `result` or `rejects` | Issues `method` with `args`; asserts it resolved to a value matching `result`, or rejected with `rejects` |
| `event` | Injects `payload` as native would (the payload carries `playerId` and `loadId`) | Asserts that the next event emitted is `name`, with a payload matching `payload` |
| `engine` | — | Sends a `FakeEngine` signal: `{ "signal": "readyToPlay", "duration": 120 }` |
| `advanceClock` | Advances fake timers | Advances the virtual clock by that many seconds |
| `expectNoEvents` | — | Asserts that no event is waiting |
| `expectEngine` | — | Drains the calls `PlayerHost` made on the `FakeEngine` since the last drain, and matches the list |
| `expectAdapter` | Matches adapter members: a `get…` method is called, another function reads as `true`, anything else is read | — |
| `expectState` | Matches `controller.getState()` | — |
| `expectNoCalls` | Asserts that every call made so far has been asserted | — |
| `route` | — | Routes `uri` through the `UriRouter`, and matches the result |

**`drive.start`** takes `skipBackSeconds`, `skipForwardSeconds` and
`freshContext`. `freshContext: true` models a WebView reload: module state
starts over, and the previous player is abandoned, never destroyed. `rejects`
on a start means `createNativePlayer` must reject with that bridge code.

**`call`** takes `method`, `args`, `match`, and one of `result` / `rejects`.

- `args` is sent verbatim by native. It is also what TS asserts, unless `match`
  is given. `match` exists for `load`: native needs concrete assets to store,
  while the assets TS produces come from the real munge and are better checked
  by shape.
- The TS plugin must answer a call when it is made, which is before the runner
  reaches its step. So every TS `call` step is queued per method, and the Nth
  call of a method is answered from the Nth step naming it. A `getInfo` result
  is merged over the default info.

**`route`** matches `expect` against the route's result, seen as JSON:

- served: `{ "contentType": "…", "bytes": <length>, "text": "<UTF-8>", "hex": "<lowercase>" }`;
- failed: `{ "error": "not-found" | "key-required" }`.

### Strictness

- **TS:** every call the plugin receives must be asserted by a `call` step, in
  order. A call left over at the end, or at an `expectNoCalls`, fails the
  scenario.
- **Native:** every event emitted must be asserted by an `event` step, in order.
  An event left over at the end, or at an `expectNoEvents`, fails the scenario.
  Engine calls are checked only where an `expectEngine` step asks.

So a scenario lists the whole conversation, not just the part it is about.
That is deliberate: an extra event on one platform is exactly the drift these
files exist to catch.

## Values: refs and matchers

A value is either **sent** (native `call.args`, `engine` args; TS `event.payload`
and the plugin's answers) or **asserted** (everything else).

**Refs.** A string such as `"$load1"` (`$` then a letter, then letters, digits
or `_`) is a ref.

- *Asserted:* an unbound ref binds to the actual value; a bound one must equal
  it.
- *Sent:* a bound ref sends its value; an unbound one binds to its own name
  without the `$` (`$load1` → `"load1"`) and sends that.
- Two refs never hold equal values. This is what proves, for example, that a
  reattach minted a new `loadId`.

So each side can create real ids and still be checked: native mints
`playerId`, and TS mints `loadId`.

**Subset matching.**

- Objects: every expected key must be present and match; extra keys are fine.
- Arrays: the same length, matched element by element.
- Numbers compare by value (`1` equals `1.0`).
- `null` is a value: it does not match a missing key.

**Matchers.** An object whose keys all start with `$` is a matcher. All its
keys must hold.

| Matcher | Holds when the actual value |
|---|---|
| `{ "$absent": true }` | is missing. Also allowed when *sending*, where it drops the key |
| `{ "$any": true }` | is present (`null` included) |
| `{ "$prefix": "s" }` | is a string starting with `s` |
| `{ "$length": n }` | is an array or string of length `n` |
| `{ "$each": p }` | is an array whose every element matches `p` |
| `{ "$contains": p }` | is an array with some element matching `p` |
| `{ "$not": p }` | does not match `p` |

`$contains` and `$not` try a pattern without keeping its bindings, so any ref
inside them must already be bound.

## The native test seam

Both platforms expose the same harness, which the runner drives. Kotlin:

```kotlin
interface ConformanceHarness {
    /** A PlayerRegistry wired to FakeEngine and a virtual clock, reporting these capabilities. */
    fun start(capabilities: JsonObject)
    /** The same decode and validation path as LuminaryPlayerPlugin, without the Capacitor call. */
    fun call(method: String, args: JsonObject): CallResult
    /** Drives the current FakeEngine. */
    fun engine(signal: String, args: JsonObject)
    fun advanceClock(seconds: Double)
    /** What EventSink emitted since the last drain, in order: { "name", "payload" }. */
    fun drainEvents(): List<JsonObject>
    /** The calls PlayerHost made on FakeEngine since the last drain: { "method", …args }. */
    fun drainEngineCalls(): List<JsonObject>
    /** Through the UriRouter of the most recently created player, even after it is destroyed. */
    fun route(uri: String): RouteResult
}
```

The Swift protocol has the same members.

- **Engine calls** are recorded as `{ "method": "load", "masterUri", "startPosition"? }`,
  `{ "method": "seek", "position", "exact" }` (with the default resolved to
  `false`), `{ "method": "setRate", "rate" }`, `{ "method": "setVariant", "id" }`,
  `{ "method": "setAudioTrack", "id" }`, and `{ "method": "<name>" }` for
  `reattach`, `play`, `pause`, `enterFullscreen`, `exitFullscreen` and `destroy`.
- **`EventSink` and `PlayerHost` take the injectable clock**, so every timer
  here runs on virtual time.

## `FakeEngine`

The same fake on both platforms, so that a scenario means the same thing on
each. A command only records itself: nothing changes state until a signal
says so. That lets a scenario put the engine's answers exactly where it wants
them.

It holds a `position`, a `duration`, a `bufferedEnd`, a `playing` flag, a
`rate` (1 by default), `hasVideo`, the audio tracks and the variants. While
`playing`, the position advances with the virtual clock at `rate`.

| Signal | Args | Engine state |
|---|---|---|
| `readyToPlay` | `duration` (a number, or `null` while unbounded), `hasVideo` (default `true`) | The item is ready |
| `playing` | — | Playing |
| `paused` | — | Paused |
| `buffering` | — | Waiting for data |
| `seeked` | `position` | A seek finished, at `position` |
| `ended` | — | Reached the end |
| `tracks` | `tracks`, `activeId` | The audio track list |
| `variants` | `variants` | The variant list |
| `failed` | `category`, `code`, `message` | The engine failed. Reserved for the phase 3 recovery scenarios; the v1 reference refuses it |
| `bufferedTo` | `end` | The buffered range around the playhead now ends at `end` |
| `position` | `position` | The position jumped without a seek |
| `rate` | `rate` | The rate is now `rate`: the answer to a `setRate`, or the viewer's pick in native UI |

Adding a signal is a change to this format, and to both fakes in the same
change.

## Validation and rejection order

Every call is checked in this order, and the first failure is the rejection:

1. **Capability** (`unsupported`): `setVariant` needs `variantSwitching`,
   `putLive` needs `live`, `warmChunks` needs `chunkWarming`. The arguments of
   an unsupported call are not looked at.
2. **Arguments** (`invalid-argument`): every required field of the method's
   args in `bridge.ts` is present with its JSON type, and every optional one is
   absent or of its type. Numbers must be finite. Also:
    - `generation` is a non-negative integer;
    - `keyHex` is 32 hex characters;
    - `startPosition` and `position` are not negative, and `rate` is positive;
    - every asset in `load` / `putAssets` is addressed to that call's
      generation (`luminary://asset/<generation>/…`), and `masterUri` is a
      `luminary://asset/` address.
3. **Player** (`unknown-player`): no player with that `playerId`. `destroy` of a
   player already destroyed resolves instead.
4. **Generation** (`stale-generation`): `load`, `putAssets` or `putLive` for a
   generation older than the player's current one.

`create` rejects `protocol-mismatch` after its arguments pass, when
`protocolVersion` is not the native side's own. A refused call changes nothing.

## Emission rules the v1 scenarios pin

The bridge states these rules. These are the readings both platforms implement,
so that virtual time gives exactly one right answer:

- **No event before a player's first `load`**: there is no load to stamp it
  with, so an engine signal before then is dropped.
- **`variants-updated`** is emitted on a `variants` signal only when
  `variantSwitching` is true; otherwise the list is always empty, so there is
  nothing to announce.

- **`readyToPlay`** emits `durationchange`, then `loadedmetadata`.
- **`load` and `reattach`** emit `audiotracks-updated` with `tracks: []` and
  `activeId: null`, before anything else for that load. A `tracks` signal
  then emits the list.
- **`timeupdate`, while playing:** one every 0.25 s of clock, counted from the
  later of the last `timeupdate` and the `playing` transition. There is none at
  the transition itself.
- **`timeupdate` on seek and pause:** on `seeked`, a `timeupdate` then `seeked`;
  on `paused`, a `timeupdate` then `pause`.
- **`progress`:** at most one per 1 s of clock. A change inside the window is
  held, and the latest value goes out when the window ends.
- **`ratechange`** is emitted on a `rate` signal only when the rate differs
  from the player's last one. A new player starts at 1, and a `load` or
  `reattach` keeps the rate.
- **`exitFullscreen`** calls `pause` on the engine, unless the item has no
  video (`hasVideo: false`).
- **`destroy`** zeroes the key, drops every asset, and cancels the player's
  timers, a held `progress` included. It resolves again if it is repeated. A
  destroyed player emits nothing, and any other call naming it rejects
  `unknown-player`. `reset` destroys every player the same way.
- **`releaseAssets`** keeps a generation answerable until a `load` of a newer
  generation has been handed to the engine. A `load` of an older generation
  rejects `stale-generation`.
- **`create`** when `maxPlayers` players exist destroys the oldest, silently.

Times in the scenarios are exact in binary floating point (multiples of
1/8 s), so every runner computes the same positions without a tolerance.

## Adding a scenario

- Name it `NN-what-it-pins.json`. Every runner picks it up without being told.
- Write the whole conversation, and mark each step's side where the kind alone
  does not say it.
- A change to `bridge.ts` lands with a scenario that pins it, in the same PR,
  together with both `BridgeTypes` mirrors.
- A scenario for a parity-gated capability sets that capability to `true` in
  `capabilities`. The capability turns on only once every runner passes it.
