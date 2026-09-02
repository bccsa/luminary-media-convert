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

Building from FFmpeg's own **GPG-signed** source removes those third parties, and
it is what makes the licence position checkable: the configure line is recorded in
`BUILDCONF.txt` beside the binary, and `verify-package.mjs` fails the package
unless the shipped encoder reports LGPL and carries no libx264.

See [`ffmpeg-build/README.md`](../../ffmpeg-build/README.md) for what goes into the
build and why, and [`docs/ffmpeg-licensing.md`](../../docs/ffmpeg-licensing.md) for
the licence position.

## What _is_ committed here

Nothing but this file. The binaries are built, and the licence text travels with
them: `build.sh` copies `COPYING.LGPLv2.1` out of the FFmpeg source tarball it
just built from, so the text beside a binary is literally the one that source
shipped under. LGPL-2.1 s.6 asks for a _copy_ — a link is not one.

The build also removes any `GPL-*.txt` left in the output directory by an earlier
run, because a GPL text beside an LGPL binary misdescribes it.
