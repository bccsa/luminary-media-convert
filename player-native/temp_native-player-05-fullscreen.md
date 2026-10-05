# Plan 05: Full-screen with the web player's experience

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

**Owner:** Johan (the spec, the web additions and iOS). **Android:** Dirk, from the same spec.

**Depends on:** plan 03's phase 2 (the native full-screen presenter) on iOS, and plan 02's on
Android.

## Goal

Pressing play in the Capacitor app opens full-screen, as intended. That full-screen is today the
system player (`AVPlayerViewController` on iOS, Media3's on Android), which looks like the phone
and not like `player-web`. This plan replaces it with our own full-screen, drawn natively to the
web player's design, so a viewer gets the same player on the web and in the app.

## Decisions (2026-10-05)

1. **Copy `player-web`'s full-screen exactly**, then add what it lacks: the **current time and
   duration**, and a **buffering spinner**. They are added to `player-web` too, first, so the two
   stay the same and the web is the reference.
2. **Volume:** native shows a **mute button only**; the phone's hardware buttons set the volume.
   The web keeps its slider.
3. **Android is Dirk's**, built from the spec below. This plan does not schedule it.
4. **No HTML controls over the native video:** they would stop answering whenever JavaScript is
   frozen, and they raise the problem inline video was deferred for (see the overview).

## The spec

The reference both platforms build to. Measured from `player-web` (`src/styles.css`,
`src/vjs/playerOptions.ts`, `src/vjs/autoHide.ts`, `src/components/LuminaryPlayer.vue`). Where
the web changes in step 1, the spec changes with it.

### Layout

| Area | Control | Rule |
|---|---|---|
| Centre | Play/pause | 96 px square |
| Centre | Skip back, skip forward | Either side of play/pause, 100 px from the centre, 56 px circles. 10 s by default, snapped to 5/10/30; 0 removes the button |
| Bottom | Progress bar | Full width but the exit button; rounded; played and loaded |
| Bottom | Time *(new)* | Current time and duration. Live shows `LIVE` instead |
| Bottom right | Exit full-screen | |
| Top left, one row | Audio language | Only with 2+ tracks |
| Top left | Picture in picture | |
| Top left | Subtitles | Only when the source has subtitles |
| Top left | Speed | 0.5, 0.7, 1, 1.5 |
| Top left | Mute | Native: mute only (decision 2) |
| Centre *(new)* | Buffering spinner | While waiting for data the viewer asked to see |

Not shown, as on the web: a title, a quality menu, an angle selector.

### Look

- A flat 30% black scrim over the picture while the controls show; no gradients.
- Controls 44 px, white icons. The icons are video.js's icon font: exported once as vector
  files, used by both platforms.
- Menus: light, `#fafafa` with `#18181b` text, the selected item `#d4d4d8` and bold, 6 px
  radius, a large shadow; dark variant `#52525b` / `#f1f5f9` / `#71717a`.
- Audio-only: black, with the white 85% music-note glyph centred, over the poster when there is
  one.

### Behaviour

- Controls fade (1 s) 3 s after the last touch while playing, and stay while paused.
- A tap shows hidden controls; a tap on the picture while they show hides them.
- A double-tap leaves full-screen.
- Live: skip and speed are hidden.
- Entering full-screen turns to landscape and locks there; leaving releases it.
- Errors: to be agreed. The web shows video.js's error dialog in full-screen. Proposal: native
  closes full-screen and shows the inline error panel, where "Try again" already works.

## Steps

### 1. The web additions (`player-web`)

Add the time display and the buffering spinner to the full-screen skin: the spinner is
suppressed today (`styles.css`, `.vjs-loading-spinner`). It changes the look of the app's web
player too, so it lands as its own change, checked in the browser and in `bccsa/luminary`.

### 2. The spec as files

- This plan's spec section, kept current.
- The icons as vector files (PDF for iOS, vector drawables for Android), exported from
  video.js's font.
- A screenshot of each web state in the Lab: paused, playing, controls hidden, each menu open,
  buffering, live, audio-only.

### 3. iOS: our own full-screen

- **A new `FullscreenPresenter`** in `LuminaryPlayerUI`, replacing `PlayerViewControllerPresenter`:
  a view controller with the video in an `AVPlayerLayer` and our controls over it. The engine
  does not change: it already presents through the `FullscreenPresenter` protocol.
- **Picture in picture** through `AVPictureInPictureController`, which works with an
  `AVPlayerLayer`. The rules phase 2 settled stay: starting it is not leaving, and closing it is.
- **Already ours, unchanged:** Now Playing and the remote commands (`NowPlayingController`),
  background audio, the recovery ladder.
- **A controls model in `LuminaryPlayerCore`** for the rules: what shows, auto-hide, live,
  skips, the time text. It imports no UIKit, so it is tested with `swift test` on virtual time.
  The view draws what it says.
- **To redo by hand,** which AVKit gave for free: VoiceOver labels (`player-web`'s
  `messages.ts` has the texts), the landscape lock, scrubbing on the progress bar.

### 4. Inline (`NativeLuminaryPlayer`)

The poster and play button take `player-web`'s exact style: the big play button's
`rgba(39,39,42,0.6)` circle and its icon, and the audio-only glyph.

### 5. Bridge changes (agree with Dirk)

Speed and audio language already come back to JavaScript as viewer choices. Still missing:

- the **subtitles** choice, and the list of subtitle tracks;
- the web's `audioMenu` and `subtitlesMenu` switches in `CreateOptions`, so a host configures
  both players the same way;
- the **texts**: labels and messages, since native draws them now.

Each is a `bridge.ts` change with a plan 04 scenario, and a protocol bump if it breaks anything.

### 6. Checking that it matches

- The Lab's Web and Native modes, side by side, compared against the step 2 screenshots, state by
  state.
- The controls model's rules in unit tests.
- A device pass: every control, picture in picture in and out, rotation, VoiceOver, live, audio-only.

## Open

- Errors in full-screen (above).
- Where the time sits on the bottom row, settled in step 1 on the web.
