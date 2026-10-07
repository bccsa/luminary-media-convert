# Luminary Cast receiver

The page a TV loads when the phone casts to it: Google's Cast player for the picture, the timeline
and the remote's play, pause and seek, plus a menu at the top right for audio, subtitles, quality and
angle. Press **Up** on the remote to open it; **Left/Right** move between sections, **Enter** or
**Down** opens one, **Enter** picks, **Back** steps out.

Audio and subtitles switch on the TV. Quality and angle go to the phone over
`urn:x-cast:org.bccsa.luminary.player`, which casts the new master at the same position.

## Files

- `index.html`, `receiver.js`, `receiver.css`, `menu.js` — the receiver. Static; no build step.
- `menu.js` is the menu's logic without the Cast SDK, tested by `menu.spec.ts` (`npm -w player-native test`).
- `preview.html` — the receiver with a stand-in for the Cast SDK, to look at the menu in a desktop
  browser (`?keys=ArrowUp,Enter` presses keys). Do not deploy it.

## Putting it on a TV

1. Host the folder (without `preview.html` and `*.spec.ts`) at a stable **HTTPS** URL, for example
   Cloudflare Pages.
2. In the [Cast SDK Developer Console](https://cast.google.com/publish), add a **Custom Receiver**
   with that URL. Note its **app id**.
3. Until the receiver is published, register each test TV by its serial number under **Cast Receiver
   Devices**, wait up to 15 minutes, and restart the TV.
4. In the host app's `AndroidManifest.xml`, set
   `<meta-data android:name="org.bccsa.luminary.player.CAST_RECEIVER_APP_ID" android:value="<app id>" />`.
   Without it the phone casts to Google's Default Media Receiver, which has no menu.

Pick the TV's own Chromecast in the device list. A Cast imitation app on the TV (AirScreen and the
like) may play the stream but not hand it the remote's keys.

Every host serving segments must answer CORS for `GET`/`HEAD` with `Range` allowed: the receiver is a
web page.
