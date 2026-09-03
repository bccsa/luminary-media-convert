# @luminary-media-converter/player-web-legacy

The Luminary app's **Video.js 8** player, wired to this repo's playback stack.

It plays what the encoder produces — LMCENC-encrypted playlists and sidecars,
the `luminary://key` sentinel, byte-range chunk chains, multi-angle masters —
inside chrome that is visually and behaviourally the app's existing player. That
is the point of the package: the migration to the Luminary player stack can
happen without the viewer seeing a different player on the day it lands.

It is a sibling of [`player-web`](../player-web), not a replacement:

|                     | `player-web`                         | `player-web-legacy`                        |
| ------------------- | ------------------------------------ | ------------------------------------------ |
| Engine              | hls.js on a bare `<video>`           | Video.js 8 (VHS), pinned 8.23.4            |
| Chrome              | none windowed; own fullscreen UI     | Video.js control bar, Luminary skin        |
| Contract            | `PlayerController` + `LuminaryPlayer` | identical                                  |
| Extras              | scrub thumbnails                     | poster, preferred audio language, YouTube  |

Everything below the component — munging, LMCENC decryption, angle extraction,
quality capping, recovery, chunk warming — is `player-core`, shared with
`player-web`. Only the engine binding differs.

## Using it

```vue
<script setup lang="ts">
import { LuminaryPlayer } from '@luminary-media-converter/player-web-legacy';
import type { PlayerSource } from '@luminary-media-converter/player-web-legacy';

const source: PlayerSource = {
    masterUrl: 'https://cdn.example.com/media/<id>/master.m3u8',
    keyHex: '…', // 32 hex chars, for encrypted output
};
</script>

<template>
    <LuminaryPlayer
        :source="source"
        poster="https://cdn.example.com/art.jpg"
        preferred-language="en"
    />
</template>
```

The stylesheets (video.js, videojs-mobile-ui, the skin) are pulled in by
`LuminaryPlayer.vue`'s style block, in the order they have to be injected in —
from a style block rather than a script import so that no `.css` specifier
reaches the emitted declarations, where a consumer type-checking with
`skipLibCheck: false` could not resolve it. Importing the package is still all a
host does about CSS.

### Props

| Prop                | Type                        | Notes                                                                      |
| ------------------- | --------------------------- | -------------------------------------------------------------------------- |
| `source`            | `PlayerSource`              | Required. Assigning a new object reloads.                                  |
| `poster`            | `string`                    | Legacy-only. Drawn *behind* a transparent player, covering the frame.      |
| `preferredLanguage` | `string`                    | Legacy-only. Both sides canonicalize, so `en`/`eng` and `ger`/`deu` match either spelling. A manual selection suspends it until the prop or the source changes. |
| `messages`          | `Partial<PlayerMessages>`   | Strings this component draws. Video.js localizes its own chrome.           |
| `controls`          | `Partial<PlayerControlsOptions>` | Audio menu, audio/video toggle, skip intervals. Read once, at mount.  |
| `controllerOptions` | `PlayerControllerOptions`   | Chunk-warming prefetch tuning and debug logging.                           |

Exposed: `{ controller, state, enterFullscreen, exitFullscreen }`. Slots:
default (`{ state, controller }`), `coming-soon` (`{ state }`), `error`
(`{ state, error, retry }`) — the same as `player-web`'s.

### Dark mode

The menus follow a `.dark` class on an ancestor, matching the Luminary host. No
`prefers-color-scheme` query: the page around the player owns that decision, and
a player that disagreed with it would be the only dark thing on a light page.

## Consuming this from bccsa/luminary

There is no registry publish. The encoder repo is added to the app as a **git
submodule** and the three packages it needs are installed by file reference.
npm dedupes the `"*"` ranges between them, so the app gets one copy of each.

```bash
# in the luminary app repo
git submodule add https://github.com/…/luminary-media-convert vendor/luminary-media-convert
git submodule update --init --recursive

# build the submodule's libraries FIRST — the file installs below resolve
# `dist/`, which is gitignored and therefore absent on a fresh clone
cd vendor/luminary-media-convert
npm install
npm run build:libs
cd ../..

npm install \
  file:vendor/luminary-media-convert/hls \
  file:vendor/luminary-media-convert/player-core \
  file:vendor/luminary-media-convert/player-web-legacy
```

Then swap the app's `VideoPlayer.vue` internals for `LuminaryPlayer`, passing
`hlsUrl` as `masterUrl` and the saved `hlsKey` as `keyHex`.

**Every submodule update repeats the build step.** `dist/` is not committed, so
`git submodule update` alone leaves the app importing a package with no build
output — which surfaces as a module-resolution error, not as stale code.

The app keeps its own `video.js`, `videojs-mobile-ui` and `videojs-youtube`
dependencies: they are `dependencies` here at the same pinned versions, so npm
resolves one copy. **The pins are exact on purpose** (8.23.4 / 1.1.1 / 3.0.1) —
see the key-delivery note below.

## Known limitations

### YouTube mode has no controller

A `source.masterUrl` that is a YouTube link switches the component into YouTube
mode: `videojs-youtube` is lazily imported and handed the URL, and the whole LMC
pipeline is bypassed. There is nothing for a `PlayerController` to control, so
none is built — the exposed `controller` stays `null` and `state` stays at its
initial snapshot. The chrome is fully functional; the angle, quality and audio
APIs are not, because YouTube exposes no such thing. A host that renders its own
selectors should hide them when the URL is a YouTube one (`isYouTubeUrl` is
exported for exactly that).

### In-memory keys ride on a VHS internal

Encrypted playback serves AES-128 keys to VHS from memory, so nothing
key-shaped ever appears on the network. It does this by wrapping `vhs.xhr`, the
per-handler request factory — VHS's internal API, verified against the 3.17.2
bundled in video.js 8.23.4. That is why the video.js version is pinned exactly,
and why an upgrade is a deliberate event that re-runs the verification.

If that seam ever breaks, the fallback is one word: construct the adapter with
`{ keyDelivery: 'url' }`, and `player-core` mints a blob URL for the key
instead. Playback keeps working; a `blob:` key request appears in the network
panel.

### Skip intervals snap to 5, 10 or 30

Video.js ships skip-button icons for those three values only, and hides a skip
button configured to anything else. `controls.skipBackSeconds` /
`skipForwardSeconds` are therefore snapped to the nearest of them, so the label
and the jump always agree; `0` removes the button outright. The default is 10,
matching the Luminary app (`player-web` defaults to 15).

## Development

```bash
npm -w player-web-legacy run build   # dist/index.js + declarations
npm -w player-web-legacy run dev     # watch build (js + d.ts)
npm -w player-web-legacy run demo    # test harness on http://localhost:5182
```

The demo plays any master URL through the real component: paste a plain or
encrypted master (plus its 32-hex key), a poster URL, a preferred language, or a
YouTube link. With prefetch debug on it logs the chunk-warming schedule to the
console. For an encrypted session, the check that matters is the network panel:
no request carrying the key, and no `luminary://` request at all.
