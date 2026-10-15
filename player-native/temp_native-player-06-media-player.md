# Plan 06: The media player

> Paths without a repository name refer to `bccsa/luminary-media-convert`. Paths in the app are
> prefixed with `bccsa/luminary`.

**Owner:** Johan. **Agreed with:** Dirk (2026-10-05), on the "Media player (one player)" page of
the design canvas: <https://claude.ai/artifact/2GrF5VGgBWEMauFDa4tcq6> (private; ask Johan).

**Depends on:** the native player (plans 01–05), and `bccsa/luminary`'s `feat/native-video-player`
(the build-target `video-player` service).

## What was agreed

One player for audio and video, with the app's `AudioPlayer` look, that keeps playing across the
app.

- **M0, content page:** the poster and one play button, as today. Play opens the media player.
- **M1 / M2, the media player:** an Audio / Video switch at the top changes mode at the same
  moment. Video mode shows the picture, audio mode the cover, with no video downloaded. Author,
  title, date, progress with times, skip ±10 s (video.js's glyphs), play/pause, speed, language.
  A drag handle (swipe down) and a chevron minimise it.
- **The sheet:** at the bottom of the player, **Up next · Chapters · About**, each shown only when
  it has something; a swipe up opens it half-screen (M6), the player still running above it.
- **M3, the mini bar:** the minimised player, across Home, Explore, Watch and Search. A tap
  reopens the player; ✕ stops.
- **M4, full-screen:** today's native full-screen (plan 05), from the player's corner button or
  by turning the phone; exit returns to the player.
- **M5, the setting:** Data saving → "Start as audio" decides the mode play starts in.

## The decision for native: video mode shows the poster (option 3)

M1 plays the video inside a player the web view draws. On the native shell the picture is
AVPlayer's or ExoPlayer's, drawn outside the web view, and putting it inside web content is the
inline native video the overview defers (phase 6). So, first version:

- **Native:** in video mode, M1 shows the poster with the play glyph where the picture goes; a
  tap opens the native full-screen. This is `NativeLuminaryPlayer`'s inline frame as it is.
  Audio mode, the mini bar, the sheet and the setting are as designed.
- **Web:** the video plays inside the player, as video.js can.
- **Later:** a native layer behind a transparent region of the player (phase 6) puts the picture
  in M1 on the app too.

## Steps

### 1. `player-core`: start a load in audio mode

Today a load always starts on the default video angle (`defaultAngleId`), so "Start as audio"
would download video first and switch away from it. `PlayerSource` gains a starting angle, so a
load can begin on `AUDIO_ONLY_ANGLE_ID` and fetch no video at all. Specs in `controller.spec.ts`;
both engines get it for free, since the angle is the munge's.

### 2. `bccsa/luminary`: one player at app level

The player stops living inside the content page.

- **A media-player store** (`app/src/media-player/`): the content playing, its source, the mode,
  minimised or open, and the player's handle; `open(content)` and `close()`. It replaces
  `mediaQueue` / `addToMediaQueue` in `globalConfig.ts`.
- **`MediaPlayer.vue`, mounted once in `App.vue`:** the full player and the mini bar, built from
  `AudioPlayer.vue`'s two views. Its picture area is the build-target `video-player` component
  (web: `LuminaryPlayer`; app: `PackagedVideoPlayer`), mounted once and kept mounted while
  minimised, so playback never restarts.
- **`AudioPlayer.vue`'s own playback goes:** the `<audio>` element, `fileCollections`, its
  retry and language logic. Its views drive the player's controller instead: play, pause, seek,
  `setPlaybackRate`, `setAudioTrack` (the language menu lists the stream's tracks), `setAngle`
  for the switch. Kept: progress saving (`contentProgress.ts`, keyed by content), the watch
  tracker, `recordAffinity`, `markSeen`.
- **Its global keyboard shortcuts go,** or are scoped to the open player: today they act on the
  whole page and fight the video player's.
- **`SingleContent` / `VideoPlayer.vue`:** the page shows the poster and play; play calls
  `open(content)`. The Listen button goes: play is the one way in.
- **The 3-minute auto-close of the minimised player goes:** it stopped audio still playing.

### 3. The sheet

- **Up next:** what the app decides comes next: same series, same topic, or the queue. To agree.
- **Chapters:** `chapters/<lang>.vtt` beside the master (`hls-core`'s `sidecarPath`), handed to
  the controller as a `ChapterSidecar`; tapping one seeks. The tab shows only when the file exists.
- **About:** the content's `summary` / `text`.
- No tab with nothing in it; no sheet when none applies.

### 4. The setting

`SettingsPage.vue` gains Data saving → "Start as audio", stored with the app's other settings;
`open(content)` reads it for step 1's starting angle.

### 5. Checking it

- Specs for the store, the player's views against a fake controller, the sheet's rules, and the
  setting.
- The Lab (`player-native/example-app`) gains the media player's flow on the native build.
- A device pass in the real app: start as audio and as video, the switch both ways, browsing
  with the mini bar, the sheet, full-screen and back, the lock screen while in audio mode.

## Open

- **Up next:** where it comes from.
- **The web's mini bar while in video mode:** the picture keeps playing inside the hidden player
  (sound continues); the thumbnail shows the poster. A live thumbnail is a later nicety.
