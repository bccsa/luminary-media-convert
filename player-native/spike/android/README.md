# Android step-0 spike

Plan 02, step 0: ExoPlayer plays this encoder's output through the plugin's
real `UriRouter` (`player-native/android`, included as a module). Playlists
and the key are answered from memory, and segments go to the network over
OkHttp. The iOS spike beside it asks the same questions of AVPlayer; its
results are in `../FINDINGS.md`.

## Run it

### With the bundled sample stream (no server needed)

```bash
npm run build:libs                      # from the repository root
cd player-native/spike
python3 make-sample-stream.py           # or: python3 make-sample-stream.py <video>
```

This encodes `test-media/trim-test-1080p-4audio.mp4` the way the encoder
lays out its output: two angles (Wide, Mirror), a 720p / 360p / 240p ladder,
four audio languages, AES-128 encrypted 6 s fMP4 segments, and byte-range
chunk chains. It writes the stream to `app/src/main/assets/stream/` and
records its payload. Both are gitignored.

The app serves the stream on `http://127.0.0.1:8765`, the address the payload
was recorded against. Open the project in Android Studio and click Run. The
loopback server is never a cold edge, so its timings are a best case.

### With your own stream

1. Build the libraries, then record a payload from a real stream:

    ```bash
    npm run build:libs                      # from the repository root
    cd player-native/spike
    node make-payload.mjs --android <masterUrl> <keyHex>
    ```

    This writes `android/app/src/main/assets/payload.json`, which is
    gitignored. Rebuild the app after changing it.

2. Open `player-native/spike/android` in Android Studio, and set Gradle JDK
   to the bundled JetBrains Runtime (the build targets Java 21). Pick a
   device, then click Run.

3. On the device:
    - The first button plays the default angle from the start.
    - Every other button switches to that angle at the current position.
    - **Autorun** runs every visit under each mode, and ends with a summary.

A MinIO on the LAN over plain `http` works, because the manifest allows
cleartext. That is fine for a debug-only spike.

### Unattended

```bash
adb shell am start -n org.bccsa.luminary.spike/.MainActivity --ez autorun true
adb logcat -s LmcSpike
```

## What it answers

| Question (plan 02, step 0) | Where to read it |
|---|---|
| Does `Aes128DataSource` + `#EXT-X-BYTERANGE` + fMP4 play? | `frame first frame rendered`, and no `error` lines |
| How is the IV resolved? | `keys …`: how many `#EXT-X-KEY` tags carry an explicit IV |
| Load to first frame on a 2-hour, wide-ladder source | `frame …`, and the autorun `summary` |
| URI or content-type constraints | The three modes. `hls` is `ExoEngine`'s own path. `mime` and `infer` go through `DefaultMediaSourceFactory`, with and without the MIME type |
| Do in-memory answers stay out of the bandwidth estimate? | `stats …`: memory bytes against network bytes, beside `estimate` |
| Are the `CODECS` accepted? | `tracks …`: each variant is `ok` or `UNSUPPORTED` |
| Which rendition does ABR pick? | `format video …`, with the estimate at that moment |
