# Plan 09: our own Cast receiver, with a TV menu

Goal: while casting, the TV shows a menu at the top right, driven by the TV remote, for audio
language, subtitles, quality and angle / audio only. Google's Default Media Receiver cannot be
changed, so this needs a receiver of our own.

## What we know (checked 2026-10-07)

- The remote's keys reach a receiver page on Google TV as `keydown` events: Enter, arrows,
  BrowserBack, media keys. Where they arrive (document vs. the framework's touch layer) differs by
  device, so listen on both.
- A custom receiver must be registered in the Cast SDK Developer Console (one-off fee), served over
  HTTPS, and — until published — every test TV must be registered by serial number. Changes take up
  to 15 minutes to reach a device; restart the TV after registering.
- Audio and subtitles switch on the TV through CAF's `AudioTracksManager` / `TextTracksManager`;
  the phone hears about it through the normal media status.
- Without CORS on the bucket a web receiver cannot read segments (the R2 lesson); the receiver
  inherits that requirement.

## Design

### The receiver (new: `player-native/cast-receiver/`)

- One static page on the Cast Web Receiver framework (CAF v3), `<cast-media-player>` for the
  picture, timeline and the remote's play/pause/seek, which CAF already handles.
- A top-right overlay of our own: a button row (Audio, Subtitles, Quality, Angle) and a list for the
  open one, navigated with the arrows, chosen with Enter, closed with Back. It hides with CAF's
  own controls and shows on any key.
- Audio and subtitles: CAF track managers, on the TV. No round trip to the phone.
- Quality and angle / audio only: these are munges of the master that only `player-core` makes,
  on the phone. The receiver asks for them over a custom message namespace
  (`urn:x-cast:org.bccsa.luminary.player`): `{ type: 'select', quality | angle }`. The phone
  re-munges and casts the new master at the same position. The receiver advertises the lists it
  can offer from what the phone sends it in `customData` (labels, current choice).

### The phone

- `CastOptionsProvider` names our receiver's app id instead of the Default Media Receiver.
- Android engine: listens on the namespace and forwards a selection to JavaScript. That is a new
  bridge event (`castselection` or similar) — `bridge.ts` is Johan's; agree the shape with him first.
- JavaScript (`player-core` controller): applies the selection as if it were picked on the phone,
  which reloads, which replaces the cast item.
- `customData` on the cast item: the angle and quality lists with the current choice, so the TV
  menu matches the phone.

## Phases

1. Receiver skeleton: CAF playback, remote transport, our idle and error screens, hosted and
   registered. Phone points at its app id. Done when the encrypted R2 stream plays and the remote
   pauses it.
2. TV menu with audio and subtitles (TV-side only).
3. Quality and angle: namespace, bridge event, JS selection, `customData` lists.

## Needs from the team

- Hosting: a stable HTTPS URL for the receiver page.
- The Cast Developer Console registration and the TV's serial registered as a test device.
- Johan: the bridge event for a selection made on the TV.

## Open questions

- A quality or angle change reloads the item on the TV: a short gap, as on the phone. Acceptable?
- Published (any TV) or unpublished (registered test TVs only) for now?
