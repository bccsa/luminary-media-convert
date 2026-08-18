# Building our own FFmpeg

Why this exists, what goes in the build, and how to run it.

## Why build at all

**FFmpeg publishes no binaries.** Its release directory holds source tarballs and
nothing else — 2,456 files, not one executable. Every ready-to-run ffmpeg comes
from a third party, and until now ours did too: BtbN for Windows (listed on
ffmpeg.org, full build system public) and osxexperts.net for both Macs (one
person's site, unlisted, unsigned).

Building from FFmpeg's own signed source fixes three things at once:

1. **Provenance.** The chain becomes _FFmpeg's signed tarball → our script → our
   binary_, with no third-party website in it. Nothing to trust on reputation.
2. **The GPL obligation.** The corresponding source stops being something we
   cannot identify — x264's revision is not recoverable from a prebuilt third-party
   binary (see [`../docs/ffmpeg-corresponding-source.md`](../docs/ffmpeg-corresponding-source.md)).
   Here it is a pinned line in `versions.sh`.
3. **URL rot.** Our pinned macOS build is already unlisted upstream and could
   vanish without notice.

## Licence position: GPL, and emphatically **not** nonfree

`--enable-gpl` is required because `libx264` is GPL, and libx264 is the CPU
fallback in `FfmpegService` — without it a machine with neither VideoToolbox nor
NVENC cannot encode at all, which is the case bundling exists to serve.

`--enable-nonfree` is **never** set. FFmpeg's own `configure` is unambiguous:

> `--enable-nonfree` allow use of nonfree code, the resulting libs and binaries
> will be **unredistributable**

Unredistributable means what it says: the binary may not be conveyed to anyone,
whatever notices accompany it. It buys `libfdk-aac` and little else, and we do not
use fdk-aac — the code asks for FFmpeg's native `aac` encoder. If audio quality
ever needs improving, `libopus` is free and better than both.

`--enable-version3` is not set either, which keeps the result **GPL v2-or-later**
— the more permissive position for whoever receives it.

## What goes in, and why narrowing has a limit

"Only what we need" is right, with one boundary that matters: **encoders and
muxers are narrowed; decoders and demuxers are not.**

Users drop whatever their camera produced — ProRes, HEVC, VP9, AVI, MKV, MXF. A
minimal decoder set turns "smaller binary" into "cannot open my file", and that
lands on the user. We control what we _write_; we do not control what we are
_given_.

Every item below was taken from the arguments the API actually passes, not from a
guess about what an encoder needs:

| Need                                                                                                       | Where it comes from                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `libx264`                                                                                                  | CPU fallback, and every rendition on a machine with no GPU                              |
| `h264_videotoolbox` (macOS) / `h264_nvenc` + `h264_qsv` (Windows)                                          | `FfmpegService` acceleration modes; Windows carries both GPU paths                      |
| `aac`                                                                                                      | `-c:a aac` — native encoder, no external library                                        |
| `libwebp` + `mjpeg`                                                                                        | sprite sheets. `ThumbnailService` prefers libwebp and falls back to mjpeg, so both ship |
| `pcm_s16le`                                                                                                | `WaveformService` pipes raw audio with `-f s16le`                                       |
| muxers `hls`, `mp4`, `mpegts`, `image2`, `pcm_s16le`, `segment`, `webp`, `null`                            | HLS output, fMP4/TS segments, sprites, waveform, capability probes                      |
| demuxer `concat`                                                                                           | `-f concat` for trim segments and storyboard assembly                                   |
| filters `scale` `scale_cuda` `scale_vt` `vpp_qsv` `fps` `format` `trim` `concat` `tile` `crop` `aresample` | the filter graphs the services compose                                                  |
| **all** decoders, demuxers, parsers                                                                        | arbitrary user input — deliberately not narrowed                                        |

Turned off: documentation, `ffplay`, capture devices, and **networking** — the app
only ever reads and writes local files, so a build that cannot open a socket is
one less thing to worry about.

## Running it

```bash
ffmpeg-build/build.sh darwin-arm64      # or darwin-x64
```

Needs `nasm`, `pkg-config` and `gnupg` (`brew install nasm pkg-config gnupg`);
the rest — `make`, `git`, `curl`, `clang`, `shasum` — come with the Xcode CLT.
Output goes to `app-electron/bin/<target>/`, where `extraResources` picks it up, so
packaging needs to know nothing about how it got there.

The script verifies FFmpeg's GPG signature before it builds anything. The release
signing key fingerprint is published on ffmpeg.org:

```
FCF986EA15E6E293A5644F10B4322F04D67658D8
```

A signature that does not verify is a hard stop, not a warning.

## Windows

**Cross-compiled on Linux with mingw-w64**, never built natively — the same choice
BtbN made, and for the same reason: MSYS2 is a second world to maintain while a
cross-compiler is one `apt` package.

```bash
sudo apt-get install -y mingw-w64 nasm pkg-config gnupg clang cmake
./ffmpeg-build/build.sh win32-x64
```

**Both GPU vendors, because we cannot know which one the machine has.** The Windows
binary carries `h264_nvenc` for NVIDIA and `h264_qsv` for Intel Quick Sync, and falls
back to `libx264` when it has neither. Neither hardware encoder can be added after
the build — that is the whole reason the pair is compiled in rather than chosen at
run time.

**NVENC needs only headers.** ffmpeg compiles against `nv-codec-headers` and loads
the encoder from the user's NVIDIA driver at runtime, so the build machine needs no
GPU, no CUDA SDK and no NVIDIA hardware — which is why a GPU-less runner produces a
binary with working NVENC. `scale_cuda` comes via `--enable-cuda-llvm`, so no
proprietary `nvcc` is involved either.

**That header pin has a ceiling as well as a floor**, and only the floor is enforced
by configure. FFmpeg 8.1 needs `ffnvcodec >= 12.1.14.0`, but `n13.1.15.0` renames
`NV_ENC_CLOCK_TIMESTAMP_SET.countingType` to `countingTypeLSB`, which FFmpeg 8.1's
`nvenc.c` still uses — so a too-new header passes configure and then fails to
compile, twelve minutes in. Re-check the pin against `nvenc.c` whenever FFmpeg moves.

**Quick Sync needs a library, and it is the one thing here that is neither autotools
nor C.** `--enable-libvpl` links Intel's oneVPL dispatcher, built from
[`intel/libvpl`](https://github.com/intel/libvpl) with CMake and a generated mingw
toolchain file. Like NVENC it is a loader — the real Media SDK runtime comes out of
the user's Intel graphics driver — so again no Intel hardware is involved in building
it. Unlike NVENC it is a real library that gets statically linked, so it is part of
the conveyed work and its MIT notice ships as `LICENSE-libvpl.txt`.

One sharp edge worth knowing before it costs an afternoon: libvpl is C++, and its
`vpl.pc` leaves `Libs.private` empty. Statically linking it into FFmpeg then fails on
undefined C++ symbols — and FFmpeg's `configure` reports that not as a link error but
as `libvpl >= 2.6 not found`. `build.sh` appends `Libs.private: -lstdc++` to the
installed `.pc` for exactly this reason.

The `.exe` links statically, so it carries libgcc and libwinpthread rather than
expecting DLLs beside it, and the build audits its own import table to prove it.

**Verified on Windows, not inferred.** `ffmpeg-build.yml` cross-compiles on Linux and
then runs the result on a `windows-latest` runner, which reported `cuda` among the
hwaccels, `h264_nvenc` and `libx264` among the encoders, `scale_cuda` among the
filters, and wrote an HLS ladder, a libwebp sprite and 32,768 bytes of raw PCM.

The same job asks the binary for `h264_qsv`, `vpp_qsv`, `scale_qsv` and `qsv` among
the hwaccels. That is **presence, not function**: the runner has neither an NVIDIA
nor an Intel GPU, so no hardware encode can be attempted on it by either path.
Presence is still the question worth asking there, because it is the one a
cross-build cannot answer for itself and the one that cannot be fixed after
shipping. A Quick Sync encode on real Intel hardware has not been run.

## Measured, not estimated

First build of `darwin-arm64`, on an M-series Mac:

|             | Result                                                        |
| ----------- | ------------------------------------------------------------- |
| Build time  | **~2 minutes** (x264 ~20s, FFmpeg ~90s)                       |
| Binary size | **20 MB**, against 49 MB for the osxexperts build it replaces |
| Licence     | GPL **v2-or-later** — `-L` confirms, no `--enable-version3`   |
| Signature   | FFmpeg's own GPG signature verified before building           |

The two-minute figure is not a typo, and it is why the earlier "20–40 minutes per
target" estimate was wrong: **x265 is what makes an FFmpeg build slow**, and we
don't ship it. Dropping it took the build from tens of minutes to two, and 29 MB
off the binary.

Narrowing was verified against real media rather than assumed:

- `-f s16le` raw PCM (waveform) — exact byte count
- HLS encode, `libx264` + `aac`, fMP4 segments
- `h264_videotoolbox` hardware encode
- Sprite sheet via `fps,scale,tile` + `libwebp`
- `ffprobe` on a 4K H.264 source

And input support stayed wide, which was the point of narrowing only the output
side:

|          | ours    | Homebrew's full build |
| -------- | ------- | --------------------- |
| Decoders | **535** | 539                   |
| Demuxers | **358** | 364                   |
| Encoders | **15**  | 201                   |
| Muxers   | **16**  | 187                   |

ProRes, HEVC, VP9, AV1, DNxHD, VC-1, MXF, Matroska, MOV — all still open. What we
gave up is the ability to _write_ formats nothing asks for.
