# Plan 01: The native player bridge

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

**Owner:** Johan. **Unblocks:** plans 02 (Android), 03 (iOS) and 04 (conformance tests).

Background, the decisions already made and the parity rules are in
[the overview](temp_native-player-00-overview.md).

**Scope: the bridge only.** That is the contract between JavaScript and native, and
the JavaScript side of it. Everything behind the contract on a device belongs to
the platform owners (plans 02 and 03): native types, stores, routing and engines.
The conformance tests are plan 04.

## What this plan delivers

1. **`player-native/src/bridge.ts`, protocol v1.** The single source of truth for
   the calls, the events, the payload types, the URI scheme, the rejection codes
   and the obligations every native side must meet.
2. **The TypeScript half:** `createNativePlayer`, `NativeBridgeAdapter`,
   `NativeServeStrategy` and `AssetBatch`. It joins `player-core`'s
   `PlayerAdapter` / `ServeStrategy` to the bridge, and is one engine-agnostic
   implementation for both platforms.
3. **The plugin package scaffold:**
   - `player-native/` as a Capacitor plugin (`registerPlugin('LuminaryPlayer')`,
     the `capacitor` field in `package.json`);
   - a workspace entry, and an entry in `build:libs`;
   - empty `ios/` and `android/` folders, handed to their owners.

## Gate that starts plans 02 and 03

The platform plans start when all of these hold:

- `bridge.ts` is tagged as protocol v1;
- the TypeScript half is built and unit-tested;
- `npm run build:libs` passes with `player-native` included.

Plan 04 (conformance tests, Dirk) turns this contract into shared test scenarios.
It can start as soon as the `bridge.ts` draft exists, and its v1 scenarios run
against the TypeScript half before the freeze.

The platform owners' device spikes (step 0 of plans 02 and 03) run *before* the
freeze. Their findings, for example on content types or the URI form, go into v1.

## The contract: `bridge.ts`

### Conventions

- **Units:** time in seconds as a double; rates as doubles; the key as 32 hex
  characters, the same form as `PlayerSource.keyHex`.
- **Identity:**
  - `playerId` comes from `create`.
  - JavaScript creates a `loadId` for every `load` / `reattach`, and every event
    carries both ids. The adapter drops events whose `loadId` is not the current
    one. A native-created id could reach JavaScript after the events that carry it.
  - `generation` is one controller `load()`. `NativeServeStrategy.release()` bumps
    it, and the controller calls `release()` once per `load`
    (`player-core/src/controller.ts:605`).
- **Ordering:** each player's commands must be applied by native in arrival order.
- **Rejections:** native uses exactly these codes (`call.reject(message, code)`):

  | Code | Meaning |
  |---|---|
  | `unsupported` | the capability is false |
  | `unknown-player` | no such `playerId` |
  | `stale-generation` | the generation is older than the current one |
  | `invalid-argument` | an argument failed validation |
  | `protocol-mismatch` | the two sides disagree on the protocol version |
  | `engine` | the engine itself failed |

### URI scheme (what native must answer)

| URI | Answer |
|---|---|
| `luminary://asset/<generation>/<n>.<ext>` | The asset's text, with its `contentType`. A missing asset fails as not-found and is never retried |
| `luminary://key` (`LUMINARY_KEY_PLACEHOLDER_URI`) | Exactly 16 bytes of the current key. With no key, it fails with `key-required`. The key is zeroed on destroy or replace, and never logged |
| `luminary://live/<n>` | A live playlist registered by `putLive`, one fresh read per engine request, with no timer. A released address is never answered (`docs/suspension-safe-playback.md`, *Live*). Only when `live` is true |
| `https://…` | Not the bridge's concern: the engine fetches it directly |

The rules native must follow:

- **Generation lifetime.** A generation is never evicted while it is in use.
  Within one generation the pipeline reuses media-playlist URLs
  (`player-core/src/pipeline/pipeline.ts:408`), so an angle switch adds only a new
  master. A released generation may be purged once the next item has taken over.
- **Memory reads.** In-memory answers must not count toward the engine's bandwidth
  estimate.

### Types

```ts
import type {
    AdapterAudioTrack, AdapterErrorCategory, AdapterVariant, ChunkBoundary, RecoveryPolicy,
} from '@luminary-media-converter/player-core';

export const PROTOCOL_VERSION = 1;

export interface BridgeCapabilities {
    variantSwitching: boolean;   // engine-inherent: may differ per platform
    pictureInPicture: boolean;   // engine-inherent
    renderText: boolean;         // side-loaded VTT — parity-gated (false for now)
    live: boolean;               // parity-gated
    chunkWarming: boolean;       // parity-gated
    backgroundAudio: boolean;    // parity-gated
    maxPlayers: number;          // 1 in v1
}
export interface BridgeInfo { protocolVersion: number; platform: 'ios' | 'android'; capabilities: BridgeCapabilities }

export interface BridgeAsset { uri: string; contentType: string; text: string }   // text, never base64
export interface NowPlaying { title: string; subtitle?: string; artworkUrl?: string }
/** player-core's LivePlaylistSpec as data; the key travels as hex, like keyHex. */
export interface BridgeLiveSpec { url: string; baseUrl: string; keyUri?: string; keyHex?: string; refreshSec: number }

export interface CreateOptions { skipBackSeconds: number; skipForwardSeconds: number }
export interface LoadArgs {
    playerId: string; loadId: string; generation: number;
    masterUri: string;               // luminary://asset/…
    assets: BridgeAsset[];           // everything new in this generation
    keyHex?: string;
    startPosition?: number;
    recovery: RecoveryPolicy;        // resolved by player-core
    nowPlaying: NowPlaying;
    requestHeaders?: Record<string, string>;   // reserved; unused in v1
}
export interface Snapshot { currentTime: number; duration: number; bufferedEnd: number; playing: boolean }
export interface ResumeResult { snapshot: Snapshot; pendingReload?: { reason: 'wedged' | 'fatal'; attempt: number } }

export interface LuminaryPlayerPlugin {
    getInfo(): Promise<BridgeInfo>;
    reset(): Promise<void>;                                   // destroys players from an earlier JS context
    create(o: CreateOptions): Promise<{ playerId: string }>;
    load(a: LoadArgs): Promise<void>;
    putAssets(a: { playerId: string; generation: number; assets: BridgeAsset[] }): Promise<void>;
    putLive(a: { playerId: string; generation: number; uri: string; spec: BridgeLiveSpec }): Promise<void>;   // 'unsupported' unless live
    releaseAssets(a: { playerId: string; generation: number }): Promise<void>;   // live specs too
    reattach(a: { playerId: string; loadId: string }): Promise<void>;
    play(a: { playerId: string }): Promise<void>;
    pause(a: { playerId: string }): Promise<void>;
    seek(a: { playerId: string; position: number; exact?: boolean }): Promise<void>;
    setRate(a: { playerId: string; rate: number }): Promise<void>;
    setVariant(a: { playerId: string; id: string | 'auto' }): Promise<void>;      // 'unsupported' unless variantSwitching
    setAudioTrack(a: { playerId: string; id: string }): Promise<void>;
    warmChunks(a: { playerId: string; loadId: string; schedules: ChunkBoundary[][]; leadSeconds: number; warmBytes: number }): Promise<void>;   // 'unsupported' unless chunkWarming
    enterFullscreen(a: { playerId: string }): Promise<void>;
    exitFullscreen(a: { playerId: string }): Promise<void>;   // pauses unless audio-only
    resumed(a: { playerId: string }): Promise<ResumeResult>;
    destroy(a: { playerId: string }): Promise<void>;          // idempotent
    addListener<E extends BridgeEventName>(event: E, fn: (e: BridgeEventMap[E]) => void): Promise<PluginListenerHandle>;
}
```

### Events (what native must emit)

Every event carries `{ playerId, loadId }`. The adapter events keep their
`AdapterEventMap` names exactly.

| Event | Payload | Rule |
|---|---|---|
| `timeupdate` | `{ currentTime }` | 4 Hz while playing, plus once on seek and once on pause |
| `durationchange` | `{ duration }` | On change; `Infinity` for live |
| `progress` | `{ bufferedEnd }` | At most 1 Hz. The buffered range *containing* the playhead |
| `playing` / `pause` / `waiting` / `seeked` / `ended` | — | On transition |
| `stalled` | `{ stalled }` | Only on the engine's own verdict |
| `error` | `{ category: AdapterErrorCategory, fatal, code, message }` | `fatal` only once the recovery obligation is spent (`player-core/src/types.ts:494–521`) |
| `reload-requested` | `{ reason, attempt }` | Held while suspended, and returned by `resumed()` instead |
| `variants-updated` | `{ variants: AdapterVariant[] }` | The lists travel with the event |
| `audiotracks-updated` | `{ tracks: AdapterAudioTrack[], activeId }` | An **empty list first** on every `load` / `reattach` (`types.ts:560`), then the new list |
| `loadedmetadata` | `{ duration }` | Once duration and the seekable range are known |
| `presentationchange` | `{ state: 'inline' \| 'fullscreen' \| 'pip' }` | On a presentation change |

### Lifecycle and resume

- **Order of calls:** `getInfo` (a version check; `protocol-mismatch` if it fails)
  → `reset` → `create` → (`load` | `reattach` | transport)* → `destroy`.
- **Resume.**
  - JavaScript calls `resumed()` on `visibilitychange` → visible and on
    `@capacitor/app` `resume`, deduplicated.
  - Native answers with the snapshot, plus any held `reload-requested`.
  - The adapter re-emits `timeupdate`, `durationchange`, `progress` and
    `playing` / `pause`, then the held request
    (`docs/suspension-safe-playback.md`, *Resume*).

### Versioning

- A breaking change bumps `PROTOCOL_VERSION`. An additive field is optional, and an
  older side ignores it.
- Every change to `bridge.ts` lands with a matching conformance scenario from plan
  04 (see the parity rules in the overview).

## The TypeScript half (`player-native/src/`)

- **`createNativePlayer(options)`** returns `{ controller, adapter }`.
  - It calls `getInfo()` / `reset()` once per JS context, then `create`.
  - It builds `new PlayerController(adapter, { ...controllerOptions, serveStrategy })`,
    passing `fetchImpl` through.
  - This is the only entry point a host uses.
- **`NativeServeStrategy implements ServeStrategy`.**
  - `serve(content, contentType)` returns `luminary://asset/<gen>/<n>.<ext>`, with
    the extension taken from the content type (`m3u8` / `vtt`). It records the
    bytes and the type in `AssetBatch`.
  - `release()` bumps the generation and queues `releaseAssets`.
  - `serveLive` → `putLive` is added only when both platforms turn `live` on
    (phase 4). Until then its absence makes the pipeline refuse live sources.
  - Reference: `player-web/src/serve/BlobServeStrategy.ts`.
- **`AssetBatch`**, shared by the strategy and the adapter, sends only assets not
  yet sent in this generation: inline in `load`, or through `putAssets` for
  anything served after the load.
- **`NativeBridgeAdapter implements PlayerAdapter`:**

| `PlayerAdapter` | Bridge |
|---|---|
| `capabilities` | From `getInfo()`: `{ nativeHls: false, keyDelivery: 'memory', variantSwitching, renderText }` |
| `loadSource(src)` | A new `loadId`; clear the mirror (audio tracks → `[]` + `audiotracks-updated`); `load({ …, assets: batch.take() })` |
| `reattach()` | A new `loadId`; the same audio-track rule; `reattach` |
| `play` / `pause` / `seek` / `setPlaybackRate` | `play` / `pause` / `seek` / `setRate` |
| `getCurrentTime` / `getDuration` / `getVariants` / `getAudioTracks` | A synchronous mirror, fed by the current `loadId`'s events |
| `setVariant` | `setVariant`; a no-op when `!variantSwitching` |
| `setAudioTrack` | Ignored until the current `loadId`'s tracks arrive |
| `setTextTracks` / `setActiveTextTrack` | No-ops while `!renderText` |
| `warmChunks` | Defined only when `chunkWarming` |
| `recover?` | Not implemented. Recovery happens on the native side |
| `on` / `destroy` | Bridge listeners filtered by `playerId` / `loadId`; `destroy` |

Capacitor sends `presentationchange` and `loadedmetadata` to the host component
(phase 2); the adapter does not forward them.

## Build order

1. Scaffold the plugin package; add it to the workspace and to `build:libs`.
2. Draft `bridge.ts`, fold in the step-0 spike findings from plans 02 and 03, then
   freeze v1.
3. Build `NativeServeStrategy`, `AssetBatch`, `NativeBridgeAdapter` and
   `createNativePlayer`. Plan 04's Vitest runner exercises them against the
   scenarios. **The gate is now met.**

## Verification

- `npm -w player-native test` passes: unit tests of the adapter, the strategy and
  `AssetBatch` against a real `PlayerController`, using the
  `player-core/src/test-support` fixtures. Plan 04's conformance run is part of the
  same command.
- `npm run build:libs` passes with `player-native` included.
- `npm -w player-core test` and `npm -w player-web test` are unchanged and pass.
