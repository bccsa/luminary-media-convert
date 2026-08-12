#!/usr/bin/env bash
#
# Build the ffmpeg/ffprobe pair the packaged app ships, from FFmpeg's own signed
# source. See README.md for why, and what goes in.
#
#     ffmpeg-build/build.sh darwin-arm64
#
# Output lands in electron/bin/<target>/ — the same place fetch-binaries would put
# a downloaded build, so nothing downstream needs to know the difference.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
source "$here/versions.sh"

target="${1:-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m)}"
case "$target" in
    darwin-arm64 | darwin-aarch64) target=darwin-arm64; arch=arm64 ;;
    darwin-x64 | darwin-x86_64) target=darwin-x64; arch=x86_64 ;;
    *)
        echo "  ✗ Unsupported target: $target" >&2
        echo "    darwin-arm64 and darwin-x64 build here. Windows needs mingw-w64" >&2
        echo "    cross-compilation on Linux and is not wired up yet — see README.md." >&2
        exit 1
        ;;
esac

work="$here/.work/$target"
prefix="$work/deps"     # x264 installs here; ffmpeg links against it
out="$repo/electron/bin/$target"

log() { printf '\n  \033[1m%s\033[0m\n' "$1"; }
fail() {
    printf '\n  ✗ %s\n\n' "$1" >&2
    exit 1
}

# ── Prerequisites ────────────────────────────────────────────────────────────
# Checked up front rather than failing halfway through a 20-minute build.
for tool in gpg nasm pkg-config make clang git curl; do
    command -v "$tool" >/dev/null 2>&1 ||
        fail "$tool is missing. On macOS: brew install nasm pkg-config gnupg"
done

# Cross-building x86_64 on an arm64 Mac works but produces a binary this machine
# can only run under Rosetta, and the capability probes would be testing Rosetta
# rather than the target. CI has a native x64 runner; prefer it.
host_arch="$(uname -m)"
if [ "$arch" != "$host_arch" ]; then
    log "Cross-building $arch on $host_arch — the result cannot be capability-tested here"
fi

mkdir -p "$work" "$prefix" "$out"

# ── FFmpeg source, verified against the project's own signature ──────────────
log "FFmpeg $FFMPEG_VERSION source"
tarball="$work/ffmpeg-$FFMPEG_VERSION.tar.xz"
if [ ! -f "$tarball" ]; then
    curl -fsSL --retry 3 -o "$tarball" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
fi
curl -fsSL --retry 3 -o "$tarball.asc" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz.asc"

actual="$(shasum -a 256 "$tarball" | cut -d' ' -f1)"
[ "$actual" = "$FFMPEG_SHA256" ] ||
    fail "Digest mismatch.\n    expected $FFMPEG_SHA256\n    got      $actual"
echo "    ✓ sha256 matches the pin"

# The signature is the point of building from source at all: it is FFmpeg's own
# attestation of the bytes, which no third-party binary carries. Import by
# fingerprint from a keyserver, so the key does not come from the same host as
# the file it vouches for.
gpg --list-keys "$FFMPEG_SIGNING_KEY" >/dev/null 2>&1 ||
    gpg --batch --keyserver keyserver.ubuntu.com --recv-keys "$FFMPEG_SIGNING_KEY" >/dev/null 2>&1 ||
    gpg --batch --keyserver keys.openpgp.org --recv-keys "$FFMPEG_SIGNING_KEY" >/dev/null 2>&1 ||
    fail "Could not fetch FFmpeg's signing key $FFMPEG_SIGNING_KEY from any keyserver"

gpg --batch --verify "$tarball.asc" "$tarball" 2>&1 | grep -q 'Good signature' ||
    fail "GPG signature did NOT verify. Do not build this tarball."
echo "    ✓ GPG signature verified against $FFMPEG_SIGNING_KEY"

src="$work/ffmpeg-$FFMPEG_VERSION"
[ -d "$src" ] || tar -xf "$tarball" -C "$work"

# ── x264, pinned to a commit ─────────────────────────────────────────────────
log "x264 $X264_COMMIT"
x264src="$work/x264"
if [ ! -d "$x264src/.git" ]; then
    git clone -q "$X264_REPO" "$x264src"
fi
git -C "$x264src" fetch -q origin
git -C "$x264src" checkout -q "$X264_COMMIT"

if [ ! -f "$prefix/lib/libx264.a" ]; then
    (
        cd "$x264src"
        # Static, PIC, no CLI: ffmpeg links the library and nothing wants the
        # x264 command-line tool in the bundle.
        x264_flags=(--prefix="$prefix" --enable-static --enable-pic --disable-cli)
        [ "$arch" != "$host_arch" ] && x264_flags+=(--host="$arch-apple-darwin")
        ./configure "${x264_flags[@]}" >"$work/x264-configure.log" 2>&1 ||
            { tail -20 "$work/x264-configure.log"; fail "x264 configure failed"; }
        make -j"$(sysctl -n hw.ncpu)" >"$work/x264-make.log" 2>&1 ||
            { tail -20 "$work/x264-make.log"; fail "x264 build failed"; }
        make install >>"$work/x264-make.log" 2>&1
    )
fi
echo "    ✓ libx264.a"

# ── FFmpeg ───────────────────────────────────────────────────────────────────
# Narrow on the way out, wide on the way in: we control what is written, not what
# users hand us. Encoders and muxers are an allow-list; decoders, demuxers and
# parsers stay complete, or somebody's ProRes/MXF/VP9 source stops opening.
encoders="libx264,aac,libwebp,mjpeg,pcm_s16le"
# Configure uses FFmpeg's *internal* names, which are not always the names you
# pass to `-f`: raw PCM is `-f s16le` on the command line but `pcm_s16le` here.
# Getting it wrong is silent — configure accepted `s16le`, the build succeeded,
# and WaveformService's `-f s16le` then had no muxer to write with.
muxers="hls,mp4,mpegts,image2,pcm_s16le,null,segment,webp"
demuxers=""   # empty = leave every demuxer enabled

case "$target" in
    darwin-*) encoders="$encoders,h264_videotoolbox" ;;
esac

configure_flags=(
    --prefix="$work/install"
    --pkg-config-flags=--static
    --extra-cflags="-I$prefix/include"
    --extra-ldflags="-L$prefix/lib"

    # Licensing: GPL because libx264 is, and never nonfree — that produces a
    # binary FFmpeg itself describes as unredistributable. No version3 either,
    # which keeps the result v2-or-later.
    --enable-gpl
    --enable-libx264
    --enable-libwebp

    --enable-static
    --disable-shared

    # Nothing here needs documentation, a media player, capture devices or a
    # network stack. The app only ever reads and writes local files.
    --disable-doc
    --disable-ffplay
    --disable-network
    # No capture devices. Note this also removes `lavfi`, which lives in
    # libavdevice — so `-f lavfi -i testsrc=...` does not work with this build.
    # The app never uses it (checked), but it means testing needs real media.
    --disable-indevs
    --disable-outdevs
    --disable-debug

    --enable-encoder="$encoders"
    --enable-muxer="$muxers"
)

# `--disable-encoders` before the allow-list, so "everything except" becomes
# "nothing except". Same for muxers. Decoders and demuxers are untouched.
configure_flags=(--disable-encoders --disable-muxers "${configure_flags[@]}")

if [ "$arch" != "$host_arch" ]; then
    configure_flags+=(
        --enable-cross-compile
        --arch="$arch"
        --target-os=darwin
        --extra-cflags="-arch $arch"
        --extra-ldflags="-arch $arch"
    )
fi

log "FFmpeg configure + build (this is the slow part)"
(
    cd "$src"
    export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
    ./configure "${configure_flags[@]}" >"$work/ffmpeg-configure.log" 2>&1 ||
        { tail -30 "$work/ffmpeg-configure.log"; fail "FFmpeg configure failed"; }
    make -j"$(sysctl -n hw.ncpu)" >"$work/ffmpeg-make.log" 2>&1 ||
        { tail -30 "$work/ffmpeg-make.log"; fail "FFmpeg build failed"; }
)

# ── Install and report ───────────────────────────────────────────────────────
cp "$src/ffmpeg" "$out/ffmpeg"
cp "$src/ffprobe" "$out/ffprobe"
chmod 755 "$out/ffmpeg" "$out/ffprobe"

log "Built $target"
for b in ffmpeg ffprobe; do
    printf '    %s  %s MB  %s\n' "$b" \
        "$(( $(stat -f%z "$out/$b") / 1048576 ))" \
        "$(file -b "$out/$b")"
done

if [ "$arch" = "$host_arch" ]; then
    "$out/ffmpeg" -hide_banner -version | head -1 | sed 's/^/    /'
    "$out/ffmpeg" -hide_banner -L 2>&1 | sed -n '3p' | sed 's/^/    licence: /'
fi

cat <<EOF

  Next: the licence notice and GPL text still have to travel with these.
  \`npm -w electron run fetch-binaries $target\` writes them — it will skip the
  binaries, since they are already here.

EOF
