# TODO: reports from 23–26 October 2026

The bugs and requests Ivan and Dirk reported in the Luminary | Development group
since Omi started logging them (23 October), for this repo: the encoder's own
tickets, and the app tickets (bccsa/luminary) whose fix lands in the player
packages here. The full app list is in `TODO.md` on luminary's
`todo/weekend-reports` branch.

## Encoder

| Done | Ticket              | What                                                                                                                                                                                  |
| ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]  | #310                | A trimmed encode resets the rendition modes and brings back audio tracks that were removed, so it can't start (v0.0.3). **Fixed in #322: a refused start no longer rebuilt the form (still broken in 0.0.4).** |
| [x]  | #311                | The segment editor keeps one segment only: selecting a second region removes the first. **Fixed in #312.**                                                                                               |
| [x]  | bccsa/luminary#2274 | Thumbnails only cover the start of the video (new report: 37 minutes, frames only near the start). **Fixed in #313**: a short set is sampled again, or no storyboard ships.                                                 |
| [ ]  | #209                | Fails on Windows 11 with an RTX 5070 Ti: `h264_nvenc` won't open ("Function not implemented"). New report on this ticket.                                                             |

## Player packages (app tickets)

| Done | Ticket              | What                                                                                                                                         | Where                                                                                         |
| ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [x]  | bccsa/luminary#2318 | Up next shows once 60 s or less are left: show it at the end only. **#315: last 10 s.**                                                                           | `player-web` `NEXT_UP_LEAD_SECONDS`, Android `NextUp.kt`, iOS `Browse.swift`                  |
| [x]  | bccsa/luminary#2319 | Fullscreen filmstrip about half as tall, still at the bottom; a tap opens it instead of seeking; a thicker bar when there are no thumbnails. **Done: height in #316, two touches in #317.** | Android `SkinControls.kt` `rosterHeight`, iOS `FullscreenViewController.swift` `rosterHeight` |
| [x]  | bccsa/luminary#2317 | Subtitle choice not remembered: Android's `beginItem()` does not reset `reportedSubtitle`, as iOS does on load. **Fixed in #321, on every platform.** | Android `ExoEngine.kt`                                                                        |
| [x]  | bccsa/luminary#2322 | Grey boxes in Up next: Android's fallback pictures arrived on 13 Oct; re-test before changing anything.                                      | `BrowsePanel.vue`: fixed in #325                                                                      |
| [x]  | bccsa/luminary#2333 | A non-existent `audio-0` track in the audio menu, in audio mode only.                                                                        | Android `AudioTracks.kt`: fixed in #318                                                                                       |
| [x]  | bccsa/luminary#2344 | Subtitles under the picture fall on the content title on mobile web. | `player-web` `styles.css`: fixed in #326 (with bccsa/luminary#2348) |
| [ ]  | bccsa/luminary#2331 | Android lock screen shows "Unknown" as the artist: show the author, or nothing.                                                              | Android media session                                                                         |
| [ ]  | bccsa/luminary#2320 | Play/pause styling differs between portrait and fullscreen: confirm with Ivan which to keep.                                                 | native fullscreen controls                                                                    |
| [ ]  | bccsa/luminary#2334 | Battery use on Android (20.7%).                                                                                                              | `player-native`                                                                               |
| [ ]  | bccsa/luminary#2335 | Keep playback progress while the app is in the background.                                                                                   | `player-native`                                                                               |
| [ ]  | bccsa/luminary#2327 | Video angles from the extended HLS.                                                                                                          | `player-core`, `player-web`, `player-native`                                                  |
