# Player Lab

A Vue 3 app that plays through the player the way `bccsa/luminary` will. It runs
**Web** (`player-web`), **Native** (the Capacitor plugin) and **YouTube** from one
screen. Built in are stress scenarios, and a health board that says whether
anything is broken, slow or not working.

## The plugin seam

The lab reaches its player only through a Luminary-style build-time plugin
(`../../../luminary/app/src/build-time/`).

| Piece | Here |
|---|---|
| Contract and injection key | `src/build-time/contracts/video-player/` |
| Registry, `app.use(appPluginsManager)` | `src/build-time/contracts/plugin-registry.ts` |
| Browser build | `src/build-time/plugins/video-player/` |
| Capacitor build, via `VITE_NATIVE_IMPL_DIR` | `native-plugins/video-player.ts` |
| `virtual:video-player`, resolved per target | `vite-plugins/buildTargetVirtuals.ts` |

`App.vue` does `inject(VideoPlayerKey)`, then renders `<component :is>` of what
the service returns. Whichever component that is, it takes the same props, emits
the same events and exposes the same handle as `LuminaryPlayer`. That includes
`src/players/NativeVideoPlayer.vue`, the plan's phase-2 host component.

| Mode | Browser build | Android build |
|---|---|---|
| Web | `player-web` | `player-web`, in the WebView, for comparison |
| Native | **simulated**: the conformance reference native side, on real time, with a stand-in engine (`SimulatedNativePlugin.ts`) | the real plugin (ExoPlayer) |
| YouTube | `player-web`'s YouTube mode | the same. YouTube never plays natively |

The simulated native side runs the real TypeScript half of the bridge against
the reference registry. A slider makes it a slow device on purpose.

## Run it

Build the sample stream once. It is encrypted, byte-range, with 2 angles and 4
languages, the way the encoder lays out its output:

```bash
npm run build:libs                                   # repository root
python3 player-native/spike/make-sample-stream.py
```

**In a browser:** `npm -w player-native/example-app run dev`, then open
http://localhost:5190.

**On an Android phone:**

1. Keep the dev server running (`npm -w player-native/example-app run dev`).
   The phone gets the sample stream from it, over the LAN.
2. Run `npm -w player-native/example-app run android`. This builds the native
   target, syncs, and opens Android Studio. Press Run there.

The native build bakes this machine's LAN address in as `VITE_LAB_ORIGIN`. Set it
yourself if the address is the wrong one. Debug builds allow cleartext HTTP (in
`android/app/src/debug/AndroidManifest.xml`), so a LAN MinIO works as well.

## The health board

The strip at the bottom shows one of **All good**, **Slow**, **Broken** or
**Idle**. It lists the worst problems; tap it for every check.

| Check | Broken when | Slow when |
|---|---|---|
| Errors | a player error, `console.error`, or an uncaught error | — |
| Not responding | an action never took effect within its limit | — |
| Playback | `timeupdate` stops for 5 s while playing | it stops for 1.5 s |
| Load → ready, play, pause, seek, angle, mode | (the above) | p95 past its limit (`LIMITS` in `probe.ts`) |
| Main thread | lag p95 > 250 ms | > 60 ms |
| Bridge calls | `invalid-argument`, `engine` or `protocol-mismatch` | p95 > 250 ms |
| Leaks | > 2 `<video>`/`<iframe>`, or heap +150 MB | heap +60 MB |

"Ready" means the engine has the item: a `loadedmetadata` arrived after the load
began. The controller's own lifecycle turns ready earlier, as soon as a load has
been handed over. A seek has landed once playback moves on from the target: the
bridge echoes the position at once, so being at the target proves nothing.
Quality and language changes have no confirming engine event, so they time the
choice reaching state.

## Stress

Each scenario can run on its own, or you can press **Run all**, at one of these
intensities:

| Intensity | Actions | Apart |
|---|---|---|
| Gentle | 8 | 500 ms |
| Rapid | 25 | 80 ms |
| Brutal | 80 | 10 ms |

**Rapid burst** runs the five quick scenarios back to back.

A scenario **fails** if, while it ran, anything errored, any action never took
effect, or playback froze. It is **slow** if its last timed action went past the
limit. The scenarios:

- play / pause flood
- seek storm
- reload storm
- mount / unmount
- angle, quality and language hops
- mode hop
- full-screen in and out (native only)
- chaos
- soak
