# Bundled ffmpeg binaries

The packaged app ships its own `ffmpeg` and `ffprobe`. A user who downloads a
media converter has not also installed a media toolchain, and if they have, it
may be any build with any set of encoders compiled in — hardware encoding in
particular is a compile-time decision, and the difference between a two-minute
encode and a twenty-minute one.

## Getting them

```sh
npm -w electron run fetch-binaries
```

`dist:mac` and `dist:win` run this first, so a build cannot silently produce an
app that has no encoder in it. The script downloads the pair, checks a pinned
SHA-256, verifies the architecture and the encoders the app actually asks for,
and writes the licence text beside them. A digest mismatch is a hard failure:
this binary is distributed to users, and "the download changed" is precisely
what a pinned digest exists to catch.

Adding a platform means adding an entry to `TARGETS` in
`electron/scripts/fetch-binaries.mjs` — the URL, the digest, and what the build
has to be able to do.

## Where they go

The binaries are **not** in this repository (they are tens of megabytes each and
are licensed separately). The script puts them here; this is also the layout to
follow if you place them by hand:

```
electron/bin/
├── darwin-arm64/
│   ├── ffmpeg
│   └── ffprobe
└── win32-x64/
    ├── ffmpeg.exe
    └── ffprobe.exe
```

`electron-builder.yml` copies `bin/${platform}-${arch}/` into the app's
resources root, which is where `bundledBinary()` in `src/main.ts` looks. When
nothing is there the app falls back to whatever `ffmpeg` is on `PATH`, so a
build without these still runs on a developer machine — it is not shippable.

## macOS (darwin-arm64)

Needs VideoToolbox, which is what `FfmpegService` detects for hardware encoding
on Apple Silicon (`h264_videotoolbox` + the `scale_vt` filter).

- <https://www.osxexperts.net/> — static arm64 builds; this is what the fetch
  script uses
- **not** <https://evermeet.cx/ffmpeg/> — checked, and it publishes x86_64 only,
  which would run under Rosetta on the machines this app targets
- **not** Homebrew: `otool -L $(which ffmpeg)` lists eighteen dylibs under
  `/opt/homebrew`, so the binary cannot start anywhere those are absent. That is
  what "not relocatable" means in practice, and it is why a static build is the
  only candidate for shipping

Verify before shipping:

```sh
./ffmpeg -hwaccels          # must list videotoolbox
./ffmpeg -encoders | grep videotoolbox
./ffmpeg -filters  | grep scale_vt
file ./ffmpeg               # must be arm64, and should say "statically linked"
```

## Windows (win32-x64)

Needs NVENC for the NVIDIA path (`h264_nvenc` + `scale_cuda`).

- <https://github.com/BtbN/FFmpeg-Builds/releases> (`win64-gpl`) — what the fetch
  script uses, pinned to a **dated** `autobuild-*` tag rather than `latest`,
  because `latest` moves and a moving URL cannot be pinned to a digest
- or <https://www.gyan.dev/ffmpeg/builds/> — the "full" or "essentials" release
  builds
- **not** the `-gpl-shared` variants: shared means DLLs beside the executable,
  and `bundledBinary()` resolves a single file. Same reasoning that ruled out
  Homebrew on macOS

**Size, which is worth knowing before packaging.** The static `win64-gpl` build
is ~144 MB per binary — 297 MB for the pair, against 99 MB for the macOS two. A
Windows installer will be correspondingly larger, and `gyan.dev`'s "essentials"
build is the smaller option if that matters more than codec coverage.

**Verification cannot happen on another platform.** The script checks the
architecture from `file` on any machine, but `-hwaccels` / `-encoders` /
`-filters` require *running* the binary. Fetching `win32-x64` from a Mac is
allowed and says so loudly: the binaries are pinned and packageable, and their
hardware support has been taken on trust until someone runs the fetch on Windows.

`strings` is not a substitute. `h264_nvenc` and `scale_cuda` do appear in the
Windows binary — but so does `videotoolbox`, which cannot work there, so the
strings come from name tables rather than proving compiled-in support.

Verify:

```
ffmpeg -hwaccels
ffmpeg -encoders | findstr nvenc
```

## Licensing

**A GPL v2-or-later build is shipped, and the choice is not free.** LGPL builds
omit `libx264`, which is the CPU fallback in `FfmpegService` — without it the app
cannot encode at all on a machine with no VideoToolbox or NVENC, which is the
one case bundling exists to serve.

The version matters and was previously stated wrongly here and in the shipped
notice: `ffmpeg -L` reports **v2 or later**, and `-buildconf` shows
`--enable-gpl` without `--enable-version3`. Full investigation, including the
obligation we do not yet meet, is in [`docs/ffmpeg-licensing.md`](../../docs/ffmpeg-licensing.md).

The API invokes ffmpeg as a **separate process** via `child_process` and is
never linked against the FFmpeg libraries, so this is aggregation: the GPL
obligation travels with ffmpeg (its licence, and source availability), not with
this Apache-2.0 codebase. `LICENSE-ffmpeg.txt` is written beside the binaries by
the fetch script and copied into the app by `extraResources`.

That is a technical reading, not legal advice. A change of licence position
would mean either moving to `libopenh264` and adapting the encoder detection, or
accepting that machines without hardware acceleration cannot encode.

**Not compliant yet.** `x264` and `x265` are statically linked into the binary we
ship (`otool -L` shows no dynamic reference to either), so the corresponding
source obliges FFmpeg *and* both libraries at the versions built — and pointing
at ffmpeg.org's current source is not that. Publishing binary and matching source
together is the fix, and it is the same action as mirroring them off a single
third-party host (Todo item 40).
