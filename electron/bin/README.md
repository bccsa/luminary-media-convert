# Bundled ffmpeg binaries

The packaged app ships its own `ffmpeg` and `ffprobe`. A user who downloads a
media converter has not also installed a media toolchain, and if they have, it
may be any build with any set of encoders compiled in — hardware encoding in
particular is a compile-time decision, and the difference between a two-minute
encode and a twenty-minute one.

The binaries are **not** in this repository (they are tens of megabytes each and
are licensed separately). Put them here before running `dist:mac` / `dist:win`:

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

- <https://evermeet.cx/ffmpeg/> — official-ish static builds, arm64 available
- or `brew install ffmpeg` and copy `$(brew --prefix)/bin/ffmpeg` — note that
  Homebrew builds link against Homebrew libraries and are **not** relocatable,
  so a static build is the right choice for shipping

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

GPL builds (anything with `--enable-gpl`, which includes x264) make the
distributed application subject to the GPL. If that is not wanted, ship an LGPL
build instead and accept the smaller encoder set. Whichever is chosen, the
licence text has to travel with the app.
