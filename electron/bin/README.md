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

- <https://www.gyan.dev/ffmpeg/builds/> — the "full" or "essentials" release
  builds include NVENC
- or <https://github.com/BtbN/FFmpeg-Builds/releases> (`win64-gpl`)

Verify:

```
ffmpeg -hwaccels
ffmpeg -encoders | findstr nvenc
```

## Licensing

**A GPL build is shipped, and the choice is not free.** LGPL builds omit
`libx264`, which is the CPU fallback in `FfmpegService` — without it the app
cannot encode at all on a machine with no VideoToolbox or NVENC, which is the
one case bundling exists to serve.

The API invokes ffmpeg as a **separate process** via `child_process` and is
never linked against the FFmpeg libraries, so this is aggregation: the GPL
obligation travels with ffmpeg (its licence, and source availability), not with
this Apache-2.0 codebase. `LICENSE-ffmpeg.txt` is written beside the binaries by
the fetch script and copied into the app by `extraResources`.

That is a technical reading, not legal advice. A change of licence position
would mean either moving to `libopenh264` and adapting the encoder detection, or
accepting that machines without hardware acceleration cannot encode.
