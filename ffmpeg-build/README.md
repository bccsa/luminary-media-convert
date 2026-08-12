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
   cannot identify — x264's revision is not recoverable from any third-party build
   we ship today (see [`../docs/ffmpeg-corresponding-source.md`](../docs/ffmpeg-corresponding-source.md)).
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

| Need                                                                                             | Where it comes from                                                                     |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `libx264`                                                                                        | CPU fallback, and every rendition on a machine with no GPU                              |
| `h264_videotoolbox` (macOS) / `h264_nvenc` (Windows)                                             | `FfmpegService` acceleration modes                                                      |
| `aac`                                                                                            | `-c:a aac` — native encoder, no external library                                        |
| `libwebp` + `mjpeg`                                                                              | sprite sheets. `ThumbnailService` prefers libwebp and falls back to mjpeg, so both ship |
| `pcm_s16le`                                                                                      | `WaveformService` pipes raw audio with `-f s16le`                                       |
| muxers `hls`, `mp4`, `mpegts`, `image2`, `s16le`, `null`                                         | HLS output, fMP4/TS segments, sprites, waveform, capability probes                      |
| demuxer `concat`                                                                                 | `-f concat` for trim segments and storyboard assembly                                   |
| filters `scale` `scale_cuda` `scale_vt` `fps` `format` `trim` `concat` `tile` `crop` `aresample` | the filter graphs the services compose                                                  |
| **all** decoders, demuxers, parsers                                                              | arbitrary user input — deliberately not narrowed                                        |

Turned off: documentation, `ffplay`, capture devices, and **networking** — the app
only ever reads and writes local files, so a build that cannot open a socket is
one less thing to worry about.

## Running it

```bash
ffmpeg-build/build.sh darwin-arm64      # or darwin-x64
```

Needs `nasm` and `pkg-config` (`brew install nasm pkg-config`). Output goes to
`electron/bin/<target>/`, exactly where `fetch-binaries` would have put a
downloaded build, so nothing downstream changes.

The script verifies FFmpeg's GPG signature before it builds anything. The release
signing key fingerprint is published on ffmpeg.org:

```
FCF986EA15E6E293A5644F10B4322F04D67658D8
```

A signature that does not verify is a hard stop, not a warning.

## Windows

Not here yet. Native Windows builds mean MSYS2/mingw and are unpleasant; the
practical route is what BtbN does — **cross-compile from Linux with mingw-w64** —
which is a second toolchain rather than a variation on this one. Windows continues
to use the pinned BtbN build until then, which is the best-provenance third party
we have: ffmpeg.org lists it and its entire build system is public.

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
