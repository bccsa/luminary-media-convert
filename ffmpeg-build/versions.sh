#!/usr/bin/env bash
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

# x264 from VideoLAN's own repository, pinned to a commit rather than a branch —
# "stable" moves, and a moving source cannot be corresponding source for anything.
# x264 publishes no signed releases, so the pin is the integrity control.
X264_REPO="https://code.videolan.org/videolan/x264.git"
X264_COMMIT="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"  # stable @ 2025-06-08

# libwebp, built from Google's own release tarball rather than taken from the
# system. This is not tidiness: linking Homebrew's libwebp made the first build of
# this script depend on /opt/homebrew/opt/webp/lib/libwebp.7.dylib, which does not
# exist on a user's Mac — the exact non-relocatability that ruled out Homebrew's
# ffmpeg in the first place. Sprites need it (ThumbnailService prefers libwebp and
# falls back to mjpeg), so it is built static and linked in.
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
# n13.0.19.1 — and the version has both a floor and a ceiling, which is easy to
# miss because configure only enforces the floor.
#
#   Floor:   FFmpeg 8.1 requires ffnvcodec >= 12.1.14.0. Pinning n9.1.23.3 (2019)
#            got past `git ls-remote | tail`, because a lexicographic sort puts n9
#            after n13, and failed configure with "nvenc requested, but not all
#            dependencies are satisfied".
#   Ceiling: n13.1.15.0 renames NV_ENC_CLOCK_TIMESTAMP_SET.countingType to
#            countingTypeLSB, and FFmpeg 8.1's nvenc.c still uses the old name, so
#            it passes configure and then fails to *compile*. Verified by reading
#            the header at each tag: countingType is present through n13.0.19.1.
#
# So when FFmpeg is bumped here, check this pin against the new nvenc.c rather than
# taking the newest tag.
NV_CODEC_HEADERS_TAG="n13.0.19.1"

# No x265. The encoder only ever writes H.264 — every variant in the master
# playlist is avc1 — so HEVC support is weight we would carry and never use, plus
# a second GPL dependency to account for in the corresponding source.
