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
# `os` decides which toolchain and which post-build audit runs; `exe` is the
# suffix the output carries.
case "$target" in
    darwin-arm64 | darwin-aarch64) target=darwin-arm64; os=darwin; arch=arm64; exe= ;;
    darwin-x64 | darwin-x86_64) target=darwin-x64; os=darwin; arch=x86_64; exe= ;;
    win32-x64 | windows-x64) target=win32-x64; os=mingw32; arch=x86_64; exe=.exe ;;
    *)
        echo "  ✗ Unsupported target: $target" >&2
        echo "    Known: darwin-arm64, darwin-x64, win32-x64" >&2
        exit 1
        ;;
esac

# Windows is cross-compiled with mingw-w64, never built natively — the same choice
# BtbN made, and for the same reason: MSYS2 is a second world to maintain, while a
# cross-compiler is one apt/brew package. It runs on Linux in CI; a Mac needs
# `brew install mingw-w64` (~1 GB) to do it locally.
cross_prefix=""
if [ "$os" = "mingw32" ]; then
    cross_prefix="x86_64-w64-mingw32-"
    command -v "${cross_prefix}gcc" >/dev/null 2>&1 || {
        echo "  ✗ ${cross_prefix}gcc not found." >&2
        echo "    Linux: apt-get install mingw-w64    macOS: brew install mingw-w64" >&2
        exit 1
    }
fi

# macOS-only tools are used for the sizes, cpu count and dependency audit below.
if [ "$(uname -s)" = "Darwin" ]; then
    nproc_cmd() { sysctl -n hw.ncpu; }
    filesize() { stat -f%z "$1"; }
else
    nproc_cmd() { nproc; }
    filesize() { stat -c%s "$1"; }
fi

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
tools=(gpg nasm pkg-config make git curl)
[ "$os" = "darwin" ] && tools+=(clang)
for tool in "${tools[@]}"; do
    command -v "$tool" >/dev/null 2>&1 ||
        fail "$tool is missing. On macOS: brew install nasm pkg-config gnupg"
done

# Cross-building x86_64 on an arm64 Mac works but produces a binary this machine
# can only run under Rosetta, and the capability probes would be testing Rosetta
# rather than the target. CI has a native x64 runner; prefer it.
host_arch="$(uname -m)"
native=true
# "Native" means the output can be run and probed here. A mingw build never
# can be; a mac x64 build can, under Rosetta, which is why that one is still
# capability-tested locally.
if [ "$os" = "mingw32" ] || { [ "$os" = "darwin" ] && [ "$arch" != "$host_arch" ] && [ "$host_arch" != "arm64" ]; }; then
    native=false
fi
[ "$os" = "mingw32" ] && log "Cross-building Windows with ${cross_prefix}gcc — the result cannot run here"

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
# attestation of the bytes, which no third-party binary carries.
#
# The key is vendored rather than fetched. A keyserver at build time is a network
# dependency on the least reliable kind of service — the first CI run failed on
# exactly that, having verified the digest seconds earlier — and a committed key
# means a change to it shows up in a diff rather than silently taking effect. Its
# authenticity is anchored by the fingerprint published on ffmpeg.org/download.html,
# which is checked below, so the key file cannot be swapped for another.
keyring="$work/keyring.gpg"
rm -f "$keyring" "$keyring~"
gpg --batch --no-default-keyring --keyring "$keyring" \
    --import "$here/ffmpeg-signing-key.asc" >/dev/null 2>&1 ||
    fail "Could not import ffmpeg-build/ffmpeg-signing-key.asc"

# The vendored key must be the one ffmpeg.org names. Anything else and the
# signature check below would be verifying against whatever we happened to ship.
gpg --batch --no-default-keyring --keyring "$keyring" --list-keys --with-colons 2>/dev/null |
    awk -F: '/^fpr:/ {print $10}' | grep -qx "$FFMPEG_SIGNING_KEY" ||
    fail "ffmpeg-signing-key.asc does not contain $FFMPEG_SIGNING_KEY"

gpg --batch --no-default-keyring --keyring "$keyring" \
    --verify "$tarball.asc" "$tarball" 2>&1 | grep -q 'Good signature' ||
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
        if [ "$os" = "mingw32" ]; then
            x264_flags+=(--host=x86_64-w64-mingw32 --cross-prefix="$cross_prefix")
        elif [ "$arch" != "$host_arch" ]; then
            x264_flags+=(--host="$arch-apple-darwin")
        fi
        ./configure "${x264_flags[@]}" >"$work/x264-configure.log" 2>&1 ||
            { tail -20 "$work/x264-configure.log"; fail "x264 configure failed"; }
        make -j"$(nproc_cmd)" >"$work/x264-make.log" 2>&1 ||
            { tail -20 "$work/x264-make.log"; fail "x264 build failed"; }
        make install >>"$work/x264-make.log" 2>&1
    )
fi
echo "    ✓ libx264.a"

# ── libwebp, ours rather than the system's ───────────────────────────────────
# Built here for one concrete reason: with it taken from the system, ffmpeg linked
# /opt/homebrew/opt/webp/lib/libwebp.7.dylib and the binary could not start on a
# machine without Homebrew. Every functional test still passed, because the build
# machine had it — the failure was reserved for users.
log "libwebp $LIBWEBP_VERSION"
webptar="$work/libwebp-$LIBWEBP_VERSION.tar.gz"
if [ ! -f "$webptar" ]; then
    curl -fsSL --retry 3 -o "$webptar" \
        "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-$LIBWEBP_VERSION.tar.gz"
fi
actual="$(shasum -a 256 "$webptar" | cut -d' ' -f1)"
[ "$actual" = "$LIBWEBP_SHA256" ] ||
    fail "libwebp digest mismatch.\n    expected $LIBWEBP_SHA256\n    got      $actual"

webpsrc="$work/libwebp-$LIBWEBP_VERSION"
[ -d "$webpsrc" ] || tar -xzf "$webptar" -C "$work"

if [ ! -f "$prefix/lib/libwebp.a" ]; then
    (
        cd "$webpsrc"
        webp_flags=(
            --prefix="$prefix" --enable-static --disable-shared
            # Only the encoder is wanted; nothing here decodes or animates webp.
            --disable-libwebpdemux --disable-libwebpdecoder
            --disable-libwebpextras --disable-sdl --disable-png --disable-jpeg
            --disable-tiff --disable-gif
        )
        if [ "$os" = "mingw32" ]; then
            webp_flags+=(--host=x86_64-w64-mingw32)
        elif [ "$arch" != "$host_arch" ]; then
            webp_flags+=(--host="$arch-apple-darwin" CFLAGS="-arch $arch" LDFLAGS="-arch $arch")
        fi
        ./configure "${webp_flags[@]}" >"$work/webp-configure.log" 2>&1 ||
            { tail -20 "$work/webp-configure.log"; fail "libwebp configure failed"; }
        make -j"$(nproc_cmd)" >"$work/webp-make.log" 2>&1 ||
            { tail -20 "$work/webp-make.log"; fail "libwebp build failed"; }
        make install >>"$work/webp-make.log" 2>&1
    )
fi
echo "    ✓ libwebp.a"

# ── NVENC headers (Windows only) ─────────────────────────────────────────────
# Headers, not a library. ffmpeg compiles against these and loads the encoder from
# the user's NVIDIA driver at runtime, so this machine needs no GPU and no CUDA
# SDK — which is what lets a GPU-less runner produce a binary with working NVENC.
if [ "$os" = "mingw32" ]; then
    log "nv-codec-headers $NV_CODEC_HEADERS_TAG"
    nvsrc="$work/nv-codec-headers"
    [ -d "$nvsrc/.git" ] || git clone -q "$NV_CODEC_HEADERS_REPO" "$nvsrc"
    git -C "$nvsrc" fetch -q --tags origin
    git -C "$nvsrc" checkout -q "$NV_CODEC_HEADERS_TAG"
    make -C "$nvsrc" PREFIX="$prefix" install >"$work/nv-headers.log" 2>&1 ||
        { tail -20 "$work/nv-headers.log"; fail "nv-codec-headers install failed"; }
    echo "    ✓ ffnvcodec.pc"
fi

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
    win32-*) encoders="$encoders,h264_nvenc" ;;
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

    # X11 is not optional-by-omission: configure auto-detects xlib and libxcb if
    # they are installed, and the first build of this script picked up four X11
    # dylibs from Homebrew that way. Nothing in a headless encoder wants an X
    # server, so they are turned off explicitly rather than left to whatever the
    # build machine happens to have.
    --disable-xlib
    --disable-libxcb
    --disable-sdl2

    --enable-encoder="$encoders"
    --enable-muxer="$muxers"
)

# `--disable-encoders` before the allow-list, so "everything except" becomes
# "nothing except". Same for muxers. Decoders and demuxers are untouched.
configure_flags=(--disable-encoders --disable-muxers "${configure_flags[@]}")

if [ "$os" = "mingw32" ]; then
    configure_flags+=(
        --enable-cross-compile
        --cross-prefix="$cross_prefix"
        --arch="$arch"
        --target-os=mingw32

        # NVENC for the GPU path, and cuda-llvm so `scale_cuda` can be built
        # without NVIDIA's proprietary nvcc — FfmpegService needs that filter on
        # the NVIDIA path, not just the encoder.
        --enable-nvenc
        --enable-cuda-llvm
        --enable-ffnvcodec

        # FFmpeg prefixes pkg-config with --cross-prefix, looking for
        # x86_64-w64-mingw32-pkg-config, which mingw-w64 does not ship. Left alone
        # it silently finds no libraries and reports them as absent — which is how
        # this failed the first time, on libwebp that had just been built.
        --pkg-config=pkg-config

        # -static so the .exe carries libgcc and libwinpthread rather than
        # expecting DLLs beside it. Same requirement as the macOS dependency
        # audit: one file that runs on a machine we have never seen.
        --extra-ldflags="-static"
    )
elif [ "$arch" != "$host_arch" ]; then
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
    # PKG_CONFIG_LIBDIR, not PKG_CONFIG_PATH: LIBDIR *replaces* the default search
    # directories instead of adding to them, so the only libraries configure can
    # find are the ones we built. PATH was the reason the first macOS build picked
    # up Homebrew's libwebp — pkg-config searched /opt/homebrew regardless.
    export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
    ./configure "${configure_flags[@]}" >"$work/ffmpeg-configure.log" 2>&1 ||
        { tail -30 "$work/ffmpeg-configure.log"; fail "FFmpeg configure failed"; }
    make -j"$(nproc_cmd)" >"$work/ffmpeg-make.log" 2>&1 ||
        { tail -30 "$work/ffmpeg-make.log"; fail "FFmpeg build failed"; }
)

# ── Install and report ───────────────────────────────────────────────────────
cp "$src/ffmpeg$exe" "$out/ffmpeg$exe"
cp "$src/ffprobe$exe" "$out/ffprobe$exe"
chmod 755 "$out/ffmpeg$exe" "$out/ffprobe$exe"

# ── The guard that should have existed from the first build ──────────────────
# A binary that links anything outside /usr/lib and /System is not shippable: it
# runs on this machine and fails on the user's. The first build of this script
# linked six Homebrew dylibs — libwebp, libsharpyuv and four X11 libraries — and
# every functional test passed anyway, because the build machine had them all.
# Nothing but an explicit check catches that class of fault.
log "Dependency audit"
if [ "$os" = "mingw32" ]; then
    # On Windows the equivalent question is which DLLs the .exe imports. Anything
    # beyond the OS set means a file that has to travel beside it, which is the
    # same shipping failure as a Homebrew dylib on macOS.
    allowed='KERNEL32|USER32|GDI32|ADVAPI32|SHELL32|OLE32|OLEAUT32|PSAPI|BCRYPT|SECUR32|WS2_32|MSVCRT|api-ms-win|IMM32|SETUPAPI|CFGMGR32|STRMIIDS|UUID|VERSION|DWMAPI|WINMM|SHLWAPI|MFPLAT|MF\\.|MFUUID|D3D11|DXGI|USP10|RPCRT4|CRYPT32|NORMALIZ|NETAPI32'
    foreign="$("${cross_prefix}objdump" -p "$out/ffmpeg$exe" "$out/ffprobe$exe" 2>/dev/null |
        grep -i 'DLL Name:' | sed 's/.*DLL Name: *//' | sort -u |
        grep -viE "$allowed" || true)"
else
    foreign="$(otool -L "$out/ffmpeg" "$out/ffprobe" |
        grep -oE '^\s+/[^ ]+' | tr -d '\t ' |
        grep -vE '^/usr/lib/|^/System/' | sort -u || true)"
fi
if [ -n "$foreign" ]; then
    printf '    %s\n' $foreign >&2
    fail "The binaries depend on libraries that will not be on the user's machine.
    Build the dependency statically instead of letting configure find a system copy."
fi
echo "    ✓ no foreign dependencies — relocatable"

log "Built $target"
for b in "ffmpeg$exe" "ffprobe$exe"; do
    printf '    %s  %s MB  %s\n' "$b" \
        "$(( $(filesize "$out/$b") / 1048576 ))" \
        "$(file -b "$out/$b")"
done

if [ "$native" = true ]; then
    "$out/ffmpeg" -hide_banner -version | head -1 | sed 's/^/    /'
    "$out/ffmpeg" -hide_banner -L 2>&1 | sed -n '3p' | sed 's/^/    licence: /'
fi

cat <<EOF

  Next: the licence notice and GPL text still have to travel with these.
  \`npm -w electron run fetch-binaries $target\` writes them — it will skip the
  binaries, since they are already here.

EOF
