# Plan 08: Casting on Android (Google Cast)

> Paths without a repository name refer to `bccsa/luminary-media-convert`.

**Owner:** Dirk (Android). **Protocol:** Johan owns `bridge.ts`; this plan changes none of it
(decision 1). **Status:** design, nothing built. **Hardware:** none to test with, so the plan says
what can be proven without a receiver and what cannot.

## Goal

A viewer of the native player on Android can send playback to a Chromecast / Google TV / a TV with
Chromecast built in, from the page's own button, and the page can tell when there is something to
send to and when playback is on it. Encrypted Luminary content has to work, because that is most of
the content.

Not goals: iOS Chromecast; Miracast, DLNA or Bluetooth routing (the system's own); a branded custom
receiver (the default receiver first); casting a YouTube link (that path is `player-web`).

## Decisions

1. **Reuse the AirPlay surface.** `airPlay` capability, `showAirPlayPicker`, `airplaychange
   { available, active }` already carry exactly the idea ("send picture and sound to a device near
   you, and say whether it is going to one"), and the Vue component already exposes
   `airPlayAvailable` / `airPlayActive` / `showAirPlayPicker`, so a host's cast button works on
   Android with no TypeScript change. On Android the capability means Google Cast. Johan can rename
   it to something neutral (`casting`) later; that is a mechanical protocol change with scenarios,
   and it is not a reason to hold this up.
2. **The phone serves the TV.** A Cast receiver fetches the stream itself, and our playlists and key
   live in memory behind `luminary://`. For the duration of a cast, a small HTTP server on the phone
   answers for those addresses (see *CastServer*). Segments stay where they are (the CDN); only
   playlists and the key are served from the phone.
3. **Opt-in per host**, like picture in picture: the capability is on only when the host's manifest
   says so (`org.bccsa.luminary.player.CAST` = `true`). Reasons: Cast pulls in Google Play services
   and needs a receiver id; a host without them must not see a button that cannot work; and until a
   receiver has proved this path, nothing should switch it on by default.
4. **ExoPlayer stays the engine; Cast is a second `Player` the engine can hand playback to.**
   Media3's `CastPlayer` implements `Player`, so playback commands, state and events can be routed
   through one `active` player instead of building a second engine.
5. **Selection of audio, subtitles and quality is local while casting.** The receiver chooses its own
   renditions from the master the phone serves; the page's choices are remembered and applied again
   when playback comes back. (A later phase can map audio language onto Cast tracks.)

## What the TV needs, and what we have

| Thing | Where it is | Reachable by a TV? | Plan |
|---|---|---|---|
| Master and media playlists (munged text) | `AssetStore`, `luminary://asset/<g>/<n>.m3u8` | no | serve from the phone, URIs rewritten |
| AES key | `KeyHolder`, `luminary://key` | no | serve from the phone, behind the token |
| Live playlist | resolved per request, `luminary://live/<n>` | no | serve from the phone, resolved per request |
| Segments, init, chunk objects | `https://` CDN, absolute after the munge | yes | untouched |
| LMCENC playlists | decrypted by the wrapper before the munge | n/a | nothing to do: the served text is plain |
| Sources on `http://localhost` (the Lab's dev server) | the developer's machine | no | cannot be cast; the Lab says so |

## Architecture

```
page ── showAirPlayPicker ──▶ PlayerRegistry ──▶ ExoEngine ──▶ CastSupport.showPicker()
                                                       │
      airplaychange ◀── EventSink ◀── CastSupport (castState) ─ CastContext (Play services)
                                                       │
                              session available ───────┤
                                                       ▼
                       ┌──────────────────────── ExoEngine ────────────────────────┐
                       │  local: ExoPlayer ◀── router (luminary://) ◀── AssetStore  │
                       │  cast : CastPlayer ──▶ receiver ──▶ http://phone:port/<token>/… ──▶ CastServer
                       │  active = cast ?: local  (commands, state, snapshot, events)│
                       └─────────────────────────────────────────────────────────────┘
```

### CastSupport (`engine/CastSupport.kt`)

The only place that touches the Cast SDK, behind an interface so everything else is testable
without Play services:

```kotlin
interface CastSupport {
    val available: Boolean              // Play services present, host opted in
    fun start(listener: Listener)       // begin watching routes and sessions
    fun showPicker(activity: Activity)  // chooser when idle, controller (disconnect) when connected
    fun createPlayer(): Player?         // a CastPlayer, once a session is available
    fun stop()
    interface Listener {
        fun routesChanged(available: Boolean, active: Boolean)
        fun sessionAvailable()          // playback can move to the receiver
        fun sessionLost()               // ended, or the receiver went away
    }
}
```

- Real implementation: `CastContext` obtained asynchronously (never block the main thread on Play
  services), `CastStateListener` for `routesChanged` (available = state is not
  `NO_DEVICES_AVAILABLE`; active = `CONNECTED`), `SessionAvailabilityListener` on the `CastPlayer`
  for `sessionAvailable` / `sessionLost`. The chooser is `MediaRouteChooserDialog` with the
  context's merged selector; while connected, `MediaRouteControllerDialog` (which has the
  disconnect button).
- Capability: `airPlay = hostOptedIn && GoogleApiAvailability says SUCCESS`. Checked when the
  registry is created, like picture in picture.
- Fake implementation for tests.

### CastServer (`CastServer.kt`)

A minimal HTTP/1.1 server, started when a cast begins and stopped when it ends.

- **Binding.** An ephemeral port on the Wi-Fi interface's IPv4 address only (never `0.0.0.0` on a
  mobile-data interface). If the phone has no Wi-Fi address the cast does not start, and the page is
  not told it is active.
- **Paths.** `/<token>/a/<generation>/<n>.m3u8` for assets, `/<token>/key`, `/<token>/l/<n>.m3u8` for
  a live address. Anything else is a 404, with no listing and no directory behaviour.
- **Token.** 128 bits from `SecureRandom`, new for every cast session, constant-time compared. The
  token is the whole authorisation, so it is never logged.
- **Methods and headers.** `GET`, `HEAD` and `OPTIONS`; `Access-Control-Allow-Origin: *` and
  `Access-Control-Allow-Headers: Range`, because a web receiver reads playlists and keys with
  `XMLHttpRequest`; `Cache-Control: no-store` (a live playlist must never be cached); the content
  type the bridge sent (`application/vnd.apple.mpegurl`), `application/octet-stream` for the key.
- **Rewriting.** The text served for an asset is the asset's text with every `luminary://asset/`,
  `luminary://key` and `luminary://live/` occurrence replaced by the server's base URL (a pure
  function, `rewriteForCast(text, base)`). The segment URLs are already absolute `https://`.
- **Live.** The server answers `/l/<n>.m3u8` by running the same `LiveResolver` path the player
  uses (one read per request, LMCENC and key checks included) and then rewriting.
- **Concurrency.** A small thread pool (4), a socket timeout, a request size cap, and a connection
  cap, so a misbehaving client on the LAN cannot hold the phone up.
- **Lifetime.** Created on `sessionAvailable` with assets, stopped on `sessionLost`, `destroy()` and
  `reset`. While it runs it serves the current load's generation only (`AssetStore` already keeps a
  released generation until a newer load has taken over; a cast follows the same rule).

### Engine routing (`ExoEngine`)

`private val active: Player get() = castPlayer ?: player`. Everything that commands or reads
*playback* goes through `active`: `play`, `pause`, `seek`, `setRate`, `snapshot`, `duration`, the
`timeupdate` source, `bufferedTo`. Everything that is about the *local* media pipeline stays on
`player`: track selection parameters, the video surface, the media session, the recovery ladder.
`ExoEngine` is a `Player.Listener` on both; an event from the inactive player is ignored.

**Handoff to the receiver** (`sessionAvailable`, with an item loaded):

1. Capture: position, whether playback is wanted (`playWhenReady` and not ended), rate.
2. Start `CastServer`; build the receiver's media item from the master's address
   (`http://phone:port/<token>/a/<g>/<n>.m3u8`), with the item's `nowPlaying` as metadata.
3. Silence the phone: pause the local player, mute it, and disable its video track (the same switch
   background play uses), so nothing plays or downloads locally. The local player keeps its loaded
   item and its tracks, so the page's audio and subtitle lists stay as they are.
4. `castPlayer.setMediaItem(item, position)`, `prepare()`, `playWhenReady = wanted`.
5. Tell the page: `airplaychange { available: true, active: true }`.

**Return** (`sessionLost`, or the page ends it through the controller dialog):

1. Read the receiver's position and whether it was playing; stop `CastServer`.
2. Restore the local player: unmute, re-enable video (unless the app is in the background), `seekTo`
   the position, `playWhenReady` as it was.
3. `airplaychange { available, active: false }`.

**A load while casting** (angle, quality or language change re-munges and loads): the new
generation's assets are put first, then the cast item is replaced on the receiver with the same
position, so a switch does not drop the cast. **Errors** from the cast player end the cast
(returning playback to the phone at the last known position) rather than climbing the recovery
ladder, which belongs to the local pipeline.

**Surfaces while casting.** Inline: the page's picture shows the poster/black (the local player is
detached from nothing, only silenced; the page decides what to draw from `airPlayActive`).
Full-screen stays usable and its controls drive `active`; a "Casting" caption is a later polish.
Picture in picture is refused while casting (the picture is on the TV).

### Events and state

| Event | Source |
|---|---|
| `airplaychange { available, active }` | `CastSupport.routesChanged`, deduplicated by `EventSink.airPlayChanged` (already there) |
| `playing`, `pause`, `waiting`, `ended`, `seeked`, `timeupdate`, `ratechange` | the active player, through the same `EventSink` rules as today |
| `error` | the active player; a cast error ends the cast first |

## What is safe, and what is not

- The key crosses the LAN in the clear to a device the viewer chose, behind a per-session token. That
  is the same exposure as any AES-128 HLS served over HTTP; the project already treats the masked
  key as obscurity, not DRM. It is stated here so it is a decision and not a surprise: **recommend
  allowing it, behind the manifest opt-in**, and a host that does not want it simply does not turn
  casting on.
- The server never serves anything the player does not already hold for the current load.
- Nothing about a cast is written to disk, and the token and key are never logged.

## Risks that only a receiver can settle

These are the reason the capability is opt-in until someone has a device.

1. **HLS dialect.** Our output is always fMP4 (`.m4s` + init), byte-range packed into shared chunk
   chains, AES-128 encrypted. Whether the default receiver plays *fMP4 + AES-128 + EXT-X-BYTERANGE*
   needs trying. Mitigation ready in the design: set `MediaInfo` HLS segment-format hints
   (`HlsSegmentFormat.FMP4`) through a custom `MediaItemConverter`; if the default receiver will not
   do it, the fallback is a custom receiver (CAF) with Shaka, which is a separate piece of work.
2. **Playlist and key fetch under the receiver's security model** (CORS, mixed content, cleartext
   HTTP from a receiver page). The headers above are the known requirements; the first run will say.
3. **Discovery on newer Android** (local-network permissions, multicast). The Cast SDK owns
   discovery, but the host manifest may need permissions the SDK documents; to be read against the
   target SDK when building.
4. **Receiver start-up time** against the 20 s first-chunk warming window; likely irrelevant, noted
   because warming runs on the phone's player.

## Testing

Provable without a device:

- `rewriteForCast`: every `luminary://` form, a base with a port, text with `\r\n`, no change to
  `https://` lines.
- `CastServer` over loopback: token required, wrong token 404, the three path kinds, `HEAD`,
  `OPTIONS`, CORS headers, `no-store`, request caps, stops accepting after `stop()`, concurrency.
- The live path, with a fake `LiveFetch`.
- Engine routing with the Cast SDK replaced by a fake `CastSupport` and a stand-in `Player` for the
  receiver: handoff captures and restores position, rate and intent; the local player is silenced
  and restored; a load while casting replaces the item; an error ends the cast; an event from the
  inactive player is ignored; `airplaychange` follows routes; capability off without the opt-in or
  without Play services.
- Conformance scenarios 25 and 26 already run on the Kotlin runner; nothing new is needed there.

Not provable without a receiver: everything in *Risks*. The commit that lands this says so, and the
checklist below is what to run when a device exists.

**Hardware checklist** (any Chromecast, Google TV, or TV with Chromecast built in, on the same Wi-Fi):
button appears only with a device on; connect and play an unencrypted public HLS; play the sample
stream (encrypted, byte-range, fMP4); seek, pause, rate; switch audio language and angle while
casting; leave the app and come back; turn the TV off mid-play (playback returns to the phone);
disconnect from the controller dialog; a live stream.

## Phases

1. **Pure pieces and the server**: `rewriteForCast`, `CastServer`, their tests. No Play services
   dependency. Mergeable on its own.
2. **`CastSupport`**: the interface, the fake, the real implementation, the dependency
   (`androidx.media3:media3-cast`, which brings the Cast framework and MediaRouter), the manifest
   opt-in and the capability. The page gets `airplaychange` and the picker; nothing is cast yet.
3. **Engine routing and handoff**, with the stand-in player tests.
4. **Skin and Lab**: a "Casting" state in the full-screen controls, and the Lab's AirPlay/Cast
   button wired to the component's existing surface.
5. **Hardware pass** against the checklist, then decide whether the opt-in default changes.

## Open questions

- **Name.** Keep riding on `airPlay` for now (decision 1), or have Johan add a neutral `casting`
  capability first? Cost of waiting is only the label.
- **Encrypted content policy.** Allow behind the opt-in (recommended), or cast only content with no
  key?
- **Receiver.** Default receiver (`CC1AD845`) first. Does Luminary want its own registered receiver
  (branding, a CAF receiver with Shaka for the HLS dialect) once there is hardware to test it?
- **iOS.** AirPlay with `luminary://` content has the same reachability problem on iOS (AVPlayer's
  external playback needs a URL the Apple TV can reach, and our playlists and key are in memory).
  Worth checking with Johan whether that path has been seen working with encrypted content; if not,
  the same "phone serves the TV" idea applies there.
