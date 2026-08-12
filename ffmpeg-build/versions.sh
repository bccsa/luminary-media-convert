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

# No x265. The encoder only ever writes H.264 — every variant in the master
# playlist is avc1 — so HEVC support is weight we would carry and never use, plus
# a second GPL dependency to account for in the corresponding source.
