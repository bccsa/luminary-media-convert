# @luminary-media-converter/player-web-v8

> **Retired and frozen.** `@luminary-media-converter/player-web` is now the Video.js 10 player. This one is kept
> because it is the only web player with a YouTube mode, and is not built or tested in CI. Wherever the text
> below says `player-web`, it means this package (demo: `npm -w player-web-v8 run demo`, port 5183).

The Luminary app's **Video.js 8** player, wired to this repo's playback stack.

It plays what the encoder produces — LMCENC-encrypted playlists and sidecars,
the `luminary://key` sentinel, byte-range chunk chains, multi-angle masters —
inside chrome that is visually and behaviourally the app's existing player. That
is the point of the package: the migration to the Luminary player stack can
happen without the viewer seeing a different player on the day it lands.

Everything below the component — munging, LMCENC decryption, angle extraction,
quality capping, recovery, chunk warming — is `player-core`. This package is the
engine binding and the chrome. It replaced an hls.js test implementation, which
survives, frozen and unbuilt, as `player-web-old`.

## Using it

```vue
<script setup lang="ts">
import { LuminaryPlayer } from '@luminary-media-converter/player-web';
import type { PlayerImage, PlayerSource } from '@luminary-media-converter/player-web';

const source: PlayerSource = {
    masterUrl: 'https://cdn.example.com/media/<id>/master.m3u8',
    keyHex: '…', // 32 hex chars, for encrypted output
};

const poster: PlayerImage = {
    srcset: 'https://cdn.example.com/art-640.webp 640w, https://cdn.example.com/art-1280.webp 1280w',
    fallback: '/img/fallback.jpg', // bundled with the app, so always there
};
</script>

<template>
    <LuminaryPlayer :source="source" :poster="poster" preferred-language="en" />
</template>
```

The stylesheets (video.js, videojs-mobile-ui, the skin) are pulled in by
`LuminaryPlayer.vue`'s style block, in the order they have to be injected in —
from a style block rather than a script import so that no `.css` specifier
reaches the emitted declarations, where a consumer type-checking with
`skipLibCheck: false` could not resolve it. Importing the package is still all a
host does about CSS.

### Props

| Prop                | Type                             | Notes |
| ------------------- | -------------------------------- | ----- |
| `source`            | `PlayerSource`                   | Required. Assigning a new object reloads. |
| `poster`            | `string \| PlayerImage`          | Artwork under the picture until the first frame, and while audio-only (under an always-drawn musical-note glyph; black with no poster) — windowed and in fullscreen. |
| `preferredLanguage` | `string`                         | Both sides canonicalize, so `en`/`eng` and `ger`/`deu` match either spelling. A manual selection suspends it until the prop or the source changes. |
| `messages`          | `Partial<PlayerMessages>`        | Strings this component draws. Video.js localizes its own chrome. |
| `controls`          | `Partial<PlayerControlsOptions>` | Audio menu, audio/video toggle, subtitles menu, skip intervals, `windowedControls`. Read once, at mount. |
| `controllerOptions` | `PlayerControllerOptions`        | Chunk-warming prefetch tuning and debug logging. |

Exposed: `{ controller, state, enterFullscreen, exitFullscreen, seek, play, pause }`.
Slots: default (`{ state, controller }`), `coming-soon` (`{ state }`), `error`
(`{ state, error, retry }`). Events: `timeupdate`, `loadedmetadata`, `ended` —
raised in YouTube mode too, where there is no controller.

A double-click anywhere on the frame toggles fullscreen, in and out, except on
a control (a button, slider, menu or dialog). The player handles it rather than
video.js, whose own handler refuses anything inside the control bar — and this
skin's control bar is the whole frame.

### Artwork: `PlayerImage`

```ts
interface PlayerImage {
    srcset?: string; // as for <img srcset>: "url 640w, url 1280w"
    sizes?: string; // as for <img sizes>; default: the player's width, 100vw in fullscreen
    src?: string; // a single URL, alone or beside srcset
    fallback?: string; // shown if the image fails to load — offline and uncached, say
}
```

A bare URL is shorthand for `{ src }`. The player draws the image itself, as an
`<img>` inside video.js's element — so it goes fullscreen with the picture —
rather than through video.js's poster, which takes one URL and knows nothing of
`srcset`. The shape describes an image, not a video.js option, so it survives a
change of engine.

A `srcset` is what keeps artwork up offline: the browser picks by size and pixel
ratio, and can settle for a width it already holds. A host with Luminary's
`ImageDto` builds one the way `LImageProvider` does — the file collection whose
`aspectRatio` is closest to 16:9, each file as `${bucketUrl}/${filename} ${width}w`
— and passes one of its bundled `fallbackImageUrls` as `fallback`.

### A bare windowed frame: `controls.windowedControls`

For a host that drives playback from its own interface — the encoder, whose trim
timeline and shortcuts are the whole transport — `:controls="{ windowedControls: false }"`
leaves the windowed frame bare:

- no control bar, big play button, audio/video toggle or video.js dialog, so
  nothing on the frame can take focus or a key (a focused video.js control
  swallows every key but Tab — the host's shortcuts);
- a click on the picture does nothing; a double-click toggles fullscreen;
- fullscreen shows every control, since the host's interface is out of view
  there — the host's way in is `enterFullscreen()`, or the double-click;
- the coming-soon and error panels are states, not controls, and still show; so
  do subtitles.

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
  file:vendor/luminary-media-convert/hls-core \
  file:vendor/luminary-media-convert/player-core \
  file:vendor/luminary-media-convert/player-web
```

Then swap the app's `VideoPlayer.vue` internals for `LuminaryPlayer`, passing
`hlsUrl` as `masterUrl` and the saved `hlsKey` as `keyHex`, and the content's
image as `poster` (see *Artwork* above) rather than an `LImage` behind the player
— which never reaches fullscreen.

This package was called `player-web-legacy` until it replaced the hls.js one: a
checkout from before the rename installs `file:…/player-web-legacy` and imports
`@luminary-media-converter/player-web-legacy`, and both change here.

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

### Byte-range requests get a longer timeout, on the same seam

VHS issues every segment request with a timeout of 1.5 × the target duration —
9 s for the encoder's default 6 s segments — and on a timeout takes what its
source calls emergency action: the video loader forces ABR to the lowest
rendition, the audio loader raises an error that excludes the current video
rendition or flips the audio track back to default. Both assume a slow request
means too little bandwidth for the rendition. On byte-range output it means a
cold chunk object still backhauling at the edge, and every rendition of an
angle shares that object, so the "switch down" re-requests the same cold
object at a different offset: nine seconds discarded, quality floored, wait
restarted. `vhsRequestTimeout.ts` wraps the same `vhs.xhr` factory and gives
requests carrying a `Range` header a backstop of ten times the target duration
instead. A dead request still times out; everything without a `Range` keeps
VHS's default; VHS's bandwidth-estimate early abort is untouched.

### Live streams are refreshed on the same seam

A live media playlist (no `#EXT-X-ENDLIST`) changes every target duration, and
a blob URL is frozen at creation. `BlobServeStrategy.serveLive` therefore hands
the munged master a synthetic `luminary://live/<n>` for each live media
playlist, and `vhsLivePlaylistInterceptor.ts` answers VHS's requests for it —
the first one and every refresh after — with a fresh read through
`player-core`'s `resolveLivePlaylist`: fetch, decrypt if LMCENC, rewrite. VHS
keeps its own refresh cadence, retries and error handling; an upstream failure
reaches it with the upstream status. `LuminaryPlayer` wires the strategy and the
adapter together; a host building its own controller passes the same
`BlobServeStrategy` to `new VideoJsAdapter(player, { liveSource })`, or the
live URIs have no one to answer them.

Moving to another source has a gap: the controller releases the old source's
addresses before the new one is attached, and video.js disposes the old engine
only once it is — for a switch to YouTube, only after that tech has loaded. The
old engine keeps refreshing in between. So the adapter never unwraps a handler
it is leaving (a raw `luminary://live/…` request is refused by the browser),
and a released address is left unanswered rather than failed, which would send
the old engine through its rendition exclusion ladder on its way out.

The refresh is JavaScript, so it pauses when the page is frozen — as VHS does.
A native shell cannot accept that, which is why its resolver does the same
three steps unaided; see `docs/suspension-safe-playback.md`.

### The suspension-safe split

Stall detection, the recovery ladder and chunk warming all live in this package
rather than in `player-core`, and `src/drivers/` is the set a native adapter
ports. The rule is one line — anything that has to act *during* playback cannot
live in shared JavaScript, because a native engine keeps playing while a locked
screen freezes the WebView — and `docs/suspension-safe-playback.md` is that rule
written out, with the normative semantics for each piece.

### Stalls are VHS's call

`player-core` used to run a stall watchdog of its own — a 10 s timer on
`currentTime` that seeked forward when nothing moved. It could not tell a slow
chunk fetch from a wedged decoder, its seek landed past the buffer end and
made VHS abort every request in flight, and the resulting `seeking` reset
VHS's own counters. It is gone. VHS's `PlaybackWatcher` samples the buffer
every 250 ms, skips gaps, corrects underflow and nudges a stuck decoder
itself, announcing each verdict as a `usage` event on the tech;
`vhsStallSignals.ts` reads those, reports `stalled` to the wrapper, and turns
three `vhs-unknown-waiting` verdicts inside ten seconds — VHS nudged three
times and nothing moved — into a fatal media error, which is what hands the
wrapper's reload ladder the one thing VHS cannot do: rebuild the source.

### Skip intervals snap to 5, 10 or 30

Video.js ships skip-button icons for those three values only, and hides a skip
button configured to anything else. `controls.skipBackSeconds` /
`skipForwardSeconds` are therefore snapped to the nearest of them, so the label
and the jump always agree; `0` removes the button outright. The default is 10,
matching the Luminary app.

## Development

```bash
npm -w player-web run build   # dist/index.js + declarations
npm -w player-web run dev     # watch build (js + d.ts)
npm -w player-web run demo    # test harness on http://localhost:5182
```

The demo plays any master URL through the real component: paste a plain or
encrypted master (plus its 32-hex key), a poster (a URL or a srcset, with a
fallback), a preferred language, or a YouTube link, and tick "Bare when
windowed" to see the frame the encoder embeds. With prefetch debug on it logs the chunk-warming schedule to the
console. For an encrypted session, the check that matters is the network panel:
no request carrying the key, and no `luminary://` request at all.
