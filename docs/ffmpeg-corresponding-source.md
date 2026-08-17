# Corresponding source for the FFmpeg we ship

The GPL requires that whoever receives the binary can get the source it was built
from. **Since 12 Aug 2026 that is straightforward, because we build it ourselves:**
the corresponding source is [`ffmpeg-build/`](../ffmpeg-build/) in this repository.

- [`ffmpeg-build/versions.sh`](../ffmpeg-build/versions.sh) — every source, pinned:
  the FFmpeg release and its SHA-256, the x264 commit, libwebp's version and digest,
  the nv-codec-headers tag, the libvpl commit.
- [`ffmpeg-build/build.sh`](../ffmpeg-build/build.sh) — the complete recipe,
  including the configure line.

Together they are enough for anyone to reproduce the binary. The licence notice
shipped beside each binary (`LICENSE-ffmpeg.txt`, written by the build) names them
and repeats the pins, so a recipient holding only the app can find them.

## Why this replaced a generated manifest

This file used to be generated from the third-party builds we downloaded, and it had
to record a gap it could not close: **x264's revision is not recoverable from a
prebuilt binary.** It is absent from the encoder log, the muxer metadata and the
embedded strings — so for those builds we could not name the source the GPL asks us
to offer, and would have had to ask each builder.

Building removes the question. The revision is a line in `versions.sh` because we
are the ones who chose it.

## What each shipped binary contains

|               | mac arm64 / mac Intel                                                  | Windows x64                                                                 |
| ------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Encoders      | `libx264`, `h264_videotoolbox`, `aac`, `libwebp`, `mjpeg`, `pcm_s16le` | `libx264`, `h264_nvenc`, `h264_qsv`, `aac`, `libwebp`, `mjpeg`, `pcm_s16le` |
| GPL component | `libx264` (statically linked)                                          | `libx264` (statically linked)                                               |
| Other static  | `libwebp` (BSD-3-Clause)                                               | `libwebp` (BSD-3-Clause), `libvpl` (MIT)                                    |
| Licence       | **GPL v2-or-later** — no `--enable-version3`                           | **GPL v2-or-later**                                                         |
| Not included  | `libx265`, nonfree anything, networking, capture devices               | same                                                                        |

**No `--enable-nonfree`, ever.** FFmpeg's own `configure` says such a build is
"unredistributable"; see [`ffmpeg-licensing.md`](ffmpeg-licensing.md) §2.

**No x265**, because the encoder only ever writes H.264 — which also means one fewer
GPL component in the corresponding source.

## What is still outstanding

**The repository has to be reachable by whoever receives a binary.** Naming
`ffmpeg-build/` discharges the obligation only if a recipient can actually get it —
so if this repository stays private, a release must carry the source another way.
Note that scripts and pins are not themselves the source: a strict reading of GPLv2 §3
puts the obligation on the distributor to supply the complete corresponding source,
not to point at where it can be found. The safe form is a tarball attached beside the
installer containing `ffmpeg-build/` **and** the FFmpeg, x264, libwebp and libvpl
sources it pins. Worth confirming with whoever signs off the licence position.

That is a decision about where releases are published, not a gap in the build.
