# iOS step 0: device spike findings

Plan 03, step 0: AVPlayer plays this encoder's output through the bridge's
URI scheme, before `bridge.ts` freezes at protocol v1.

## Setup

- **Device:** iPhone 13 Pro, over Wi-Fi to a MinIO on the LAN (plain http).
- **Stream:** from this encoder at `feat/native-ios-spike`:
  - 10 minutes long
  - two camera angles (`TYPE=VIDEO` groups "Wide" and "Mirror")
  - five H.264 VBR renditions per angle (1080p to 240p)
  - two audio tiers, each carrying four languages
  - AES-128 encryption, with LMCENC-encrypted playlists
  - byte-range fMP4 in shared chunk chains, 6 s segments
- **Payload:** produced by `make-payload.mjs`, which runs the real munge through
  `NativeBridgeAdapter` / `NativeServeStrategy` and records each `load`
  argument. The spike plays exactly what the bridge would carry.
- **Loader:** `AssetLoader.swift`, an `AVAssetResourceLoaderDelegate` on its
  own serial queue. It answers `luminary://asset/…` and `luminary://key` from
  memory; the segments go direct over http.
- **Run:** `-autorun` plays Wide, then switches to Mirror, then to audio only,
  under each of three ways of setting the content type (below). It logs every
  loader request and the access and error logs.

## Results

| Question | Answer |
|---|---|
| Does byte-range fMP4 play through a resource loader? | **Yes.** Every run played. |
| Which content type must the loader set? | **Any of the three works** (below). |
| Does the key work from memory? | **Yes**, 16 bytes under any content type, with the explicit IV from each playlist. |
| Do in-memory answers skew the bandwidth estimate? | **No.** Only segment requests are counted (below). |
| Are the `CODECS` attributes right? | **Yes** (below). |
| Time from load to first frame, 2-hour source | *Pending: the 2-hour encode is running.* |

### Content types

`contentInformationRequest.contentType` was set three ways, and all three played:

- **`uti`:** `UTType(mimeType:)` of the bridge's MIME type, which gives
  `public.m3u-playlist` for playlists and `public.data` for the key.
- **`mime`:** the MIME type exactly as `BridgeAsset.contentType` carries it
  (`application/vnd.apple.mpegurl`, `application/octet-stream`).
- **`none`:** left unset.

**Recommendation:** `BridgeAsset.contentType` stays a MIME type, since it is
what the TypeScript side knows. Native maps it through `UTType(mimeType:)`,
because the API documents a UTI there. No change to `bridge.ts`.

### Loader behaviour a native `UriRouter` must handle

- **One request per playlist per item,** plus the key. For example, a load of
  Wide asked for the master, one audio playlist, two video playlists and the
  key, and nothing else.
- **Data-only repeat requests.** In audio-only mode AVFoundation asks for the
  audio playlist twice. The second request has **no
  `contentInformationRequest`**, only a `dataRequest`. The router must answer
  a request that asks for data alone.
- **Every `dataRequest` in the runs asked for the whole resource.** Honour
  `requestedOffset` / `requestedLength` anyway: the spike does, and it costs
  nothing.
- **Nothing missing was ever requested,** and **nothing was cancelled.**

### Bandwidth estimate

- **Only segments are counted.** `numberOfMediaRequests` counts segment
  requests alone: `segmentsDownloadedDuration` divided by requests is exactly
  6.0 s in every run, for example 146 requests for 876 s.
- **The loader-served bytes are not in it.** Those are ~35 KB of playlists and
  the key. `observedBitrate` tracks `numberOfBytesTransferred` over
  `transferDuration` of the segments alone.
- **So the rule "in-memory answers must not count toward the bandwidth
  estimate" holds on iOS by construction.** It needs no code, only a
  conformance note.
- **Caveat:** on a LAN the estimate is 10–17 Mbps against a 415 kbps top
  rendition, so this run cannot show ABR under real pressure. The throttled
  device pass in plan 03 covers that.

### Variant selection is size-aware

- **AVPlayer mostly held 720p** (`indicated=307610`) inline, despite 10–17 Mbps
  observed. It touched 1080p once.
- **The inline view is ~1170×658 px** on this phone in portrait, so 720p is the
  largest rendition that fits. AVPlayer caps by what is displayed.
- **This matters for `variantSwitching: false`.** The "quality as reload with a
  cap" change in `player-core` sits on top of this cap, and full-screen should
  lift it. Confirm in the phase 2 presenter.

### `CODECS`

- **Every variant carries its audio codec** (`mp4a.40.2`) as well as its
  video codec.
- **The H.264 levels match the resolutions:**
  - 1080p: `avc1.640028` (4.0)
  - 720p and 480p: `avc1.64001f` (3.1)
  - 360p: `avc1.64001e` (3.0)
  - 240p: `avc1.640015` (2.1)
- **AVPlayer accepted every variant** of both angles.

### Timings (10-minute source, LAN)

**From `replaceCurrentItem` to the new item's first decoded frame**, measured
with an `AVPlayerItemVideoOutput` on that item:

| Mode | Wide (first load) | Mirror (angle switch) | Audio only (playhead moving) |
|---|---|---|---|
| uti | 139 ms | 218 ms | 131 ms |
| mime | 127 ms | 240 ms | 135 ms |
| none | 103 ms | 197 ms | 201 ms |

**Buffering:** AVPlayer buffered ~15–20 minutes of media (audio and video
counted separately) within about 12 s on the LAN. Chunk warming matters on a
CDN edge, not here.

### Payload size

**Protocol v1 load arguments, as JSON, for the 10-minute source:**

| Visit | Assets | Size | Contents |
|---|---|---|---|
| Wide (first load) | 14 | 147 KiB | the master, 5 video and 8 audio playlists |
| Mirror | 6 | 58 KiB | a new master and that angle's 5 video playlists; the audio is reused |
| Audio only | 1 | 2 KiB | the master |

**Media playlists grow linearly with duration.** A 2-hour source should
therefore send about 1.7 MB on its first load. The 2-hour run measures this,
and the time it costs, next.

## What changes in `bridge.ts`

- **Nothing breaking.** Content types, the key and the URI scheme all work as
  drafted.
- **Two notes to add to the router's obligations** (and to plan 04's `route`
  scenarios):
  1. A request may carry no `contentInformationRequest`, and must still be
     answered.
  2. `contentType` is mapped to a UTI natively.
