#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The pinned sources. Sourced by build.sh.
#
# These lines *are* the corresponding source the GPL asks us to offer: this file
# plus build.sh is enough for anyone to rebuild the binary we ship. That is the
# whole point of building rather than downloading — for a third-party build we
# cannot even name x264's revision.

# FFmpeg release tarball from ffmpeg.org, verified against the project's own GPG
# signature. 8.1 matches the macOS arm64 build we ship today, so a switch to this
# build is not also a version change.
FFMPEG_VERSION="8.1"
FFMPEG_SHA256="b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a"

# FFmpeg's release signing key, fingerprint as published on ffmpeg.org/download.html.
FFMPEG_SIGNING_KEY="FCF986EA15E6E293A5644F10B4322F04D67658D8"

# No x264, and that is the licensing decision rather than a technical one.
# --enable-gpl exists to gate libx264 and friends; without it FFmpeg builds
# LGPL-2.1, which is what lets this application ship it as a separate program
# without the combined-work question a GPL encoder would raise. The cost is that
# there is no software H.264 encoder in the binary at all — encoding uses the one
# already on the user's machine.

# libwebp, built from Google's own release tarball rather than taken from the system.
# A system libwebp makes the binary depend on a path that does not exist on a user's
# machine — /opt/homebrew/... on macOS — which is the same non-relocatability that
# rules out using Homebrew's ffmpeg. Sprites need it (ThumbnailService prefers libwebp
# and falls back to mjpeg), so it is built static and linked in.
LIBWEBP_VERSION="1.6.0"
LIBWEBP_SHA256="e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564"

# NVENC headers, for the Windows target only.
#
# Worth knowing why this is just headers: NVENC is not a library we link against.
# ffmpeg compiles against these stubs and loads the actual encoder out of the
# user's NVIDIA driver at runtime, so a build machine needs no GPU, no CUDA SDK
# and no NVIDIA hardware at all — which is why a GPU-less CI runner can produce a
# binary with working NVENC.
NV_CODEC_HEADERS_REPO="https://github.com/FFmpeg/nv-codec-headers.git"
# This pin has both a floor and a ceiling, and configure enforces only the floor.
#
#   Floor:   FFmpeg 8.1 requires ffnvcodec >= 12.1.14.0. Below it, configure fails
#            with "nvenc requested, but not all dependencies are satisfied".
#   Ceiling: n13.1.15.0 renames NV_ENC_CLOCK_TIMESTAMP_SET.countingType to
#            countingTypeLSB, which FFmpeg 8.1's nvenc.c still uses, so a newer tag
#            passes configure and then fails to *compile*. countingType is present
#            through n13.0.19.1.
#
# Note also that tags do not sort lexicographically: n9.x sorts after n13.x. When
# bumping FFmpeg, choose the tag by reading nvenc.c, not by taking the newest.
NV_CODEC_HEADERS_TAG="n13.0.19.1"
# The commit the tag points at — the *peeled* SHA (`ls-remote`'s `^{}` line), because
# an annotated tag has two hashes and `git rev-list -n1 <tag>` resolves to the commit,
# not the tag object. A tag is mutable; every other source here is pinned by digest or
# commit, and these headers are compiled into the shipped Windows binary.
NV_CODEC_HEADERS_COMMIT="88fee5c37318c991a8762d423530f91681e32e3a"

# libvpl — Intel's oneVPL dispatcher, for the Windows target only. This is what
# `--enable-libvpl` links, and it is what gives the build Quick Sync (`h264_qsv`,
# `vpp_qsv`, the `qsv` hwaccel).
#
# Like the NVENC headers above, it needs no Intel hardware to build against: the
# dispatcher is a loader, and the actual Media SDK runtime it calls comes out of the
# user's Intel graphics driver at run time. A GPU-less runner therefore produces a
# binary with working Quick Sync, exactly as it does for NVENC.
#
# Unlike them it is a real library that gets statically linked, so it is part of the
# work conveyed and its licence (MIT) ships beside the binary.
#
# FFmpeg 8.1 requires `vpl >= 2.6`; this is well past that. Tags here do sort
# sensibly, and there is no known ceiling — but a bump is still a rebuild-and-probe,
# because a dispatcher that fails to load a runtime does so silently at run time.
LIBVPL_REPO="https://github.com/intel/libvpl.git"
LIBVPL_TAG="v2.17.0"
# Lightweight tag, so `ls-remote` advertises one hash and it is the commit. Pinned
# alongside the tag all the same: the tag is mutable, the commit is not.
LIBVPL_COMMIT="d77f9195cf495b937631607333288fd917ae8939"

# AMF — AMD's encoder headers, for the Windows target only. What `--enable-amf`
# compiles against, giving the build `h264_amf`.
#
# Headers only, like nv-codec-headers: no library is linked and no AMD hardware is
# needed to build. The runtime lives in the user's Radeon driver, so a GPU-less
# runner produces a binary with working AMF exactly as it does for NVENC.
#
# Being headers, they add nothing to the conveyed work, so no notice ships for
# them — the same treatment nv-codec-headers gets above, and for the same reason.
# They are recorded in the corresponding-source list because they are an input to
# the build.
#
# The floor is verified: FFmpeg 8.1 requires AMF >= 1.4.36 (configure checks
# AMF_VERSION >= 0x0001000400240000) and this is exactly that, so the pin is the
# minimum rather than a comfortable margin. There is no ceiling to find, because
# 1.4.36 is also the newest tag published.
#
# Note the compile-time catch that goes with it: FFmpeg 8.1's vsrc_amf.c is C
# and includes AMF's DisplayCapture.h, which is C++ only. build.sh disables the
# amf_capture filter for that reason. If a later AMF or FFmpeg fixes the header,
# that --disable-filter can go.
AMF_REPO="https://github.com/GPUOpen-LibrariesAndSDKs/AMF.git"
AMF_TAG="v1.4.36"
# Annotated tag, so this is the peeled SHA — see the nv-codec-headers note above.
AMF_COMMIT="16f7d73e0b45c473e903e46981ed0b91efc4c091"

# No x265. The encoder only ever writes H.264 — every variant in the master
# playlist is avc1 — so HEVC support is weight we would carry and never use, plus
# a second GPL dependency to account for in the corresponding source.
