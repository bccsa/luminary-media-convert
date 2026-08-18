# `app-electron/bin/` — where the encoder lands

Nothing in here is committed except the licence texts. The `ffmpeg`/`ffprobe` pair
for each target is **built from source** and dropped here by
[`ffmpeg-build/build.sh`](../../ffmpeg-build/build.sh):

```bash
ffmpeg-build/build.sh darwin-arm64      # or darwin-x64, win32-x64
```

`electron-builder.yml` copies `bin/${platform}-${arch}/` into the packaged app
through `extraResources`, and `bundledBinary()` in the main process resolves it at
runtime. `npm -w app-electron run dist:mac` / `dist:win` build the encoder first, so a
packaging run cannot produce an app without one.

## Why there is no download step any more

Until 12 Aug 2026 a `fetch-binaries` script downloaded prebuilt binaries — BtbN for
Windows, osxexperts.net for both Macs. That script is gone. FFmpeg publishes no
binaries of its own, so every prebuilt one comes from a third party, and the macOS
source in particular was one person's site: unlisted on ffmpeg.org, unsigned, and
already serving a build it no longer advertised.

Building from FFmpeg's own **GPG-signed** source removes those third parties, and it
answers the GPL question that a prebuilt binary could not: x264's revision is not
recoverable from someone else's build, so we could not name the corresponding
source. Now it is a pinned line in `ffmpeg-build/versions.sh`.

See [`ffmpeg-build/README.md`](../../ffmpeg-build/README.md) for what goes into the
build and why, and [`docs/ffmpeg-licensing.md`](../../docs/ffmpeg-licensing.md) for
the licence position.

## What _is_ committed here

`licenses/GPL-2.0.txt` and `licenses/GPL-3.0.txt`. A GPL binary may not ship without
a _copy_ of its licence — a link is not one — and these have to travel whether or not
anyone reruns a build, so they are in git rather than downloaded. The build copies
the applicable text beside each binary along with a notice naming the exact sources
it was built from.
