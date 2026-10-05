# Plan 05: Full-screen with the web player's experience

> Paths without a repository name refer to `bccsa/luminary-media-convert` (where
> `player-core`, `player-web` and the new `player-native` plugin live). Paths in
> the host apps are prefixed with `bccsa/luminary` or `luminary-deployment`.

**Owner:** Johan (the spec and iOS). **Android:** Dirk, from the same spec.

**Depends on:** plan 03's phase 2 (the native full-screen presenter) on iOS, and plan 02's on
Android.

## Status (2026-10-05)

- **iOS full-screen: built, and checked in the Simulator; not yet on the device.**
  - `LuminaryFullscreenPresenter` replaces `PlayerViewControllerPresenter`: our own view, with
    the video in an `AVPlayerLayer` and picture in picture through
    `AVPictureInPictureController`, keeping phase 2's rules.
  - The rules sit in `FullscreenControls.swift` (core, tested on virtual time): which controls
    show, the 3 s auto-hide, live, the time text (video.js's `formatTime`) and the speed labels.
  - The icons are video.js's own glyphs: `ios/scripts/extract-videojs-icons.mjs` writes
    `VideoJsIcons.swift` from the SVG font video.js ships, and `VideoJsGlyph` draws them.
  - The viewer's actions go through the engine (`FullscreenCommands`), so its intent and
    JavaScript's viewer choices stay right. Mute and the subtitles choice stay native for now
    (step 4).
  - Measured against `player-web` in the Lab's Web mode at 844×390: play 96 pt, skips 56 pt at
    ±72 pt and 14 pt up, a 44 pt top row, the progress track 4 pt.
  - In the Simulator: controls over a playing video, hidden after 3 s, and kept while paused.
    Picture in picture, the menus, scrubbing, VoiceOver and rotation are for the device pass.

## Goal

Pressing play in the Capacitor app opens full-screen, as intended. That full-screen is today the
system player (`AVPlayerViewController` on iOS, Media3's on Android), which looks like the phone
and not like `player-web`. This plan replaces it with our own full-screen, drawn natively to the
web player's design, so a viewer gets the same player on the web and in the app.

## Decisions (2026-10-05)

1. **Copy `player-web`'s full-screen exactly**, then fill what native lacks: the **current time
   and duration**, and a **buffering spinner**. **`player-web` does not change:** these two are
   native-only additions. Decisions 2 and 5 are the other intended differences.
2. **Volume:** native shows a **mute button only**; the phone's hardware buttons set the volume.
   The web keeps its slider.
3. **Android is Dirk's**, built from the spec below. This plan does not schedule it.
4. **No HTML controls over the native video:** they would stop answering whenever JavaScript is
   frozen, and they raise the problem inline video was deferred for (see the overview).
5. **Orientation (2026-10-05):** full-screen opens in landscape, then follows the phone, as
   Apple's player did. This differs from `player-web`, which locks to landscape.

## The spec

The reference both platforms build to. Measured from `player-web` (`src/styles.css`,
`src/vjs/playerOptions.ts`, `src/vjs/autoHide.ts`, `src/components/LuminaryPlayer.vue`), which
stays as it is. Rows marked *(native only)* are the additions of decision 1.

### Layout

| Area | Control | Rule |
|---|---|---|
| Centre | Play/pause | 96 px square |
| Centre | Skip back, skip forward | Either side of play/pause, 100 px from the centre, 56 px circles. 10 s by default, snapped to 5/10/30; 0 removes the button |
| Bottom | Progress bar | Full width but the exit button; rounded; played and loaded |
| Bottom | Time *(native only)* | Current time and duration, left of the progress bar. Live shows `LIVE` instead |
| Bottom right | Exit full-screen | |
| Top left, one row | Audio language | Only with 2+ tracks |
| Top left | Picture in picture | |
| Top left | Subtitles | Only when the source has subtitles |
| Top left | Speed | 0.5, 0.7, 1, 1.5 |
| Top left | Mute | Native: mute only (decision 2) |
| Centre *(native only)* | Buffering spinner | In place of play/pause, while waiting for data the viewer asked to see |

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
- Entering full-screen turns to landscape, then follows how the phone is held (decision 5). In
  portrait the controls keep the screen's edges, the picture letterboxed between them.
- Errors: to be agreed. The web shows video.js's error dialog in full-screen. Proposal: native
  closes full-screen and shows the inline error panel, where "Try again" already works.

## Steps

### 1. The spec as files

- This plan's spec section, kept current.
- The icons as vector files (PDF for iOS, vector drawables for Android), exported from
  video.js's font.
- A screenshot of each web state in the Lab: paused, playing, controls hidden, each menu open,
  buffering, live, audio-only.

### 2. iOS: our own full-screen

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

### 3. Inline (`NativeLuminaryPlayer`)

The poster and play button take `player-web`'s exact style: the big play button's
`rgba(39,39,42,0.6)` circle and its icon, and the audio-only glyph.

### 4. Bridge changes (agree with Dirk)

Speed and audio language already come back to JavaScript as viewer choices. Still missing:

- the **subtitles** choice, and the list of subtitle tracks;
- the web's `audioMenu` and `subtitlesMenu` switches in `CreateOptions`, so a host configures
  both players the same way;
- the **texts**: labels and messages, since native draws them now.

Each is a `bridge.ts` change with a plan 04 scenario, and a protocol bump if it breaks anything.

### 5. Checking that it matches

- The Lab's Web and Native modes, side by side, compared against the step 1 screenshots, state by
  state; the time, the spinner, mute only and the orientation are the expected differences.
- The controls model's rules in unit tests.
- A device pass: every control, picture in picture in and out, rotation, VoiceOver, live, audio-only.

## Open

- Errors in full-screen (above).
- The exact look of the time and the spinner, which the web has no model for: proposed as white
  text in the controls' 14 px size, and a white ring at the play button's size.
