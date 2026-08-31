#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Build the ffmpeg/ffprobe pair the packaged app ships, from FFmpeg's own signed
# source. See README.md for why, and what goes in.
#
#     ffmpeg-build/build.sh darwin-arm64
#
# Output lands in app-electron/bin/<target>/, where electron-builder's extraResources
# picks it up, together with the licence texts a GPL binary must carry.
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
out="$repo/app-electron/bin/$target"

log() { printf '\n  \033[1m%s\033[0m\n' "$1"; }
fail() {
    printf '\n  ✗ %b\n\n' "$1" >&2
    exit 1
}

# ── Prerequisites ────────────────────────────────────────────────────────────
# Checked up front rather than failing halfway through a 20-minute build.
tools=(gpg gpgv shasum nasm pkg-config make git curl)
# clang compiles the CUDA kernels scale_cuda needs (--enable-cuda-llvm), so the
# Windows cross-build wants it as much as a native macOS build.
tools+=(clang)
# cmake and the C++ cross-compiler are for libvpl, the Quick Sync dispatcher: the
# only dependency here that is neither autotools nor plain C, and Windows-only.
[ "$os" = "mingw32" ] && tools+=("${cross_prefix}objdump" "${cross_prefix}g++" cmake)
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
[ -f "$tarball.asc" ] ||
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
# Verified with gpgv, not gpg. gpgv exists for exactly this job: check a detached
# signature against a keyring file, with no GNUPGHOME, no trustdb and no agent. gpg
# needs a writable home, which a CI runner does not have, and its agent socket path
# is capped at ~104 characters on macOS — shorter than a keyring inside .work.
keyring="$work/ffmpeg-keys.gpg"
gpg --dearmor < "$here/ffmpeg-signing-key.asc" > "$keyring" 2>/dev/null ||
    fail "Could not read ffmpeg-build/ffmpeg-signing-key.asc"

# --status-fd gives machine-readable output: GOODSIG says the signature is valid,
# VALIDSIG carries the fingerprint that made it. Checking the fingerprint is what
# makes the vendored key trustworthy — otherwise this would only prove the tarball
# matches whatever key we happened to ship.
status="$(gpgv --keyring "$keyring" --status-fd 1 "$tarball.asc" "$tarball" 2>/dev/null || true)"
grep -q '^\[GNUPG:\] GOODSIG' <<<"$status" ||
    fail "GPG signature did NOT verify. Do not build this tarball."
grep -q "^\[GNUPG:\] VALIDSIG $FFMPEG_SIGNING_KEY" <<<"$status" ||
    fail "Signed by an unexpected key. Expected $FFMPEG_SIGNING_KEY, got:\n    $(grep VALIDSIG <<<"$status" || echo 'no VALIDSIG line')"
echo "    ✓ GPG signature verified against $FFMPEG_SIGNING_KEY"

src="$work/ffmpeg-$FFMPEG_VERSION"
[ -d "$src" ] || tar -xf "$tarball" -C "$work"

# ── libwebp, ours rather than the system's ───────────────────────────────────
# A system libwebp links the binary against a path that exists on this machine and
# not on a user's, and every functional test still passes here because the library is
# present — so the failure would only appear after shipping.
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

webp_stamp="$prefix/.libwebp-$LIBWEBP_VERSION"
if [ ! -f "$webp_stamp" ]; then
    rm -f "$prefix"/.libwebp-* "$prefix/lib/libwebp.a"
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
    touch "$webp_stamp"
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
    git -C "$nvsrc" fetch -q --tags --force origin
    # The commit is what gets checked out; the tag is confirmed to point at it, so a
    # moved tag fails here rather than silently changing what is compiled in.
    tagged="$(git -C "$nvsrc" rev-list -n1 "$NV_CODEC_HEADERS_TAG" 2>/dev/null || true)"
    [ "$tagged" = "$NV_CODEC_HEADERS_COMMIT" ] ||
        fail "nv-codec-headers $NV_CODEC_HEADERS_TAG points at ${tagged:-nothing},\n    expected $NV_CODEC_HEADERS_COMMIT"
    git -C "$nvsrc" checkout -q "$NV_CODEC_HEADERS_COMMIT"
    make -C "$nvsrc" PREFIX="$prefix" install >"$work/nv-headers.log" 2>&1 ||
        { tail -20 "$work/nv-headers.log"; fail "nv-codec-headers install failed"; }
    echo "    ✓ ffnvcodec.pc"
fi

# ── AMF headers, for h264_amf (Windows only) ─────────────────────────────────
# AMD's equivalent of nv-codec-headers: headers only, no library, no AMD hardware
# needed. `--enable-amf` compiles against them and the runtime comes out of the
# user's Radeon driver.
#
# This is what gives a Radeon machine a hardware encoder. Without it such a
# machine has no hardware path at all — which is survivable only while libx264 is
# still compiled in.
if [ "$os" = "mingw32" ]; then
    log "AMF headers $AMF_TAG"
    amfsrc="$work/amf"
    [ -d "$amfsrc/.git" ] || git clone -q "$AMF_REPO" "$amfsrc"
    git -C "$amfsrc" fetch -q --tags --force origin
    tagged="$(git -C "$amfsrc" rev-list -n1 "$AMF_TAG" 2>/dev/null || true)"
    [ "$tagged" = "$AMF_COMMIT" ] ||
        fail "AMF $AMF_TAG points at ${tagged:-nothing},\n    expected $AMF_COMMIT"
    git -C "$amfsrc" checkout -q "$AMF_COMMIT"
    # No build system to run: FFmpeg looks for AMF/core/Version.h on the include
    # path, so the headers are copied into the prefix directly.
    mkdir -p "$prefix/include/AMF"
    cp -R "$amfsrc/amf/public/include/." "$prefix/include/AMF/"
    [ -f "$prefix/include/AMF/core/Version.h" ] ||
        fail "AMF headers did not land at $prefix/include/AMF/core/Version.h"
    echo "    ✓ AMF/core/Version.h"
fi

# ── libvpl, the Quick Sync dispatcher (Windows only) ─────────────────────────
# Quick Sync is reached through Intel's oneVPL dispatcher, which is what
# --enable-libvpl links against. The dispatcher is a loader: it finds the real Media
# SDK runtime inside the user's Intel graphics driver at run time. So, as with NVENC
# above, the build machine needs no Intel GPU and no Intel SDK.
#
# It is the one dependency here that is CMake rather than autotools, and the one
# written in C++ — which matters at link time, not build time. See the vpl.pc fixup
# below.
if [ "$os" = "mingw32" ]; then
    log "libvpl $LIBVPL_TAG"
    vplsrc="$work/libvpl"
    [ -d "$vplsrc/.git" ] || git clone -q "$LIBVPL_REPO" "$vplsrc"
    git -C "$vplsrc" fetch -q --tags --force origin
    # Same rule as nv-codec-headers: the commit is what is checked out, and the tag
    # is only confirmed to point at it, so a moved tag fails here rather than
    # quietly changing what gets linked in.
    tagged="$(git -C "$vplsrc" rev-list -n1 "$LIBVPL_TAG" 2>/dev/null || true)"
    [ "$tagged" = "$LIBVPL_COMMIT" ] ||
        fail "libvpl $LIBVPL_TAG points at ${tagged:-nothing},\n    expected $LIBVPL_COMMIT"
    git -C "$vplsrc" checkout -q "$LIBVPL_COMMIT"

    vpl_stamp="$prefix/.libvpl-$LIBVPL_COMMIT"
    if [ ! -f "$vpl_stamp" ]; then
        rm -f "$prefix"/.libvpl-* "$prefix/lib/libvpl.a" "$prefix/lib/pkgconfig/vpl.pc"
        # CMake has no --host to infer the target from, the way the autotools
        # projects above do, so it is told outright.
        cat > "$work/mingw-toolchain.cmake" <<TOOLCHAIN
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
set(CMAKE_C_COMPILER ${cross_prefix}gcc)
set(CMAKE_CXX_COMPILER ${cross_prefix}g++)
set(CMAKE_RC_COMPILER ${cross_prefix}windres)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
TOOLCHAIN
        (
            cd "$vplsrc"
            rm -rf build
            # CMAKE_INSTALL_LIBDIR is pinned to plain `lib`. GNUInstallDirs picks a
            # multiarch subdirectory on some distributions, and the FFmpeg configure
            # below searches $prefix/lib/pkgconfig and nowhere else — the package
            # would land somewhere pkg-config never looks and be reported absent.
            cmake -S . -B build \
                -DCMAKE_TOOLCHAIN_FILE="$work/mingw-toolchain.cmake" \
                -DCMAKE_INSTALL_PREFIX="$prefix" \
                -DCMAKE_INSTALL_LIBDIR=lib \
                -DCMAKE_BUILD_TYPE=Release \
                -DBUILD_SHARED_LIBS=OFF \
                -DBUILD_TESTS=OFF \
                -DBUILD_EXAMPLES=OFF \
                -DINSTALL_EXAMPLES=OFF \
                >"$work/libvpl-configure.log" 2>&1 ||
                { tail -20 "$work/libvpl-configure.log"; fail "libvpl configure failed"; }
            cmake --build build -j"$(nproc_cmd)" >"$work/libvpl-make.log" 2>&1 ||
                { tail -20 "$work/libvpl-make.log"; fail "libvpl build failed"; }
            cmake --install build >>"$work/libvpl-make.log" 2>&1
        )
        # libvpl is C++, and its own vpl.pc leaves Libs.private empty. Statically
        # linking it into FFmpeg — a C program linked with gcc — then ends in
        # undefined C++ symbols, and FFmpeg's configure reports that not as a link
        # error but as "libvpl >= 2.6 not found". Put the C++ runtime back.
        echo "Libs.private: -lstdc++" >> "$prefix/lib/pkgconfig/vpl.pc"
        touch "$vpl_stamp"
    fi
    echo "    ✓ libvpl.a + vpl.pc"
fi

# ── FFmpeg ───────────────────────────────────────────────────────────────────
# Narrow on the way out, wide on the way in: we control what is written, not what
# users hand us. Encoders and muxers are an allow-list; decoders, demuxers and
# parsers stay complete, or somebody's ProRes/MXF/VP9 source stops opening.
encoders="aac,libwebp,mjpeg,pcm_s16le"
# Configure uses FFmpeg's *internal* names, which are not always the names you
# pass to `-f`: raw PCM is `-f s16le` on the command line but `pcm_s16le` here.
# Getting it wrong is silent — configure accepted `s16le`, the build succeeded,
# and WaveformService's `-f s16le` then had no muxer to write with.
muxers="hls,mp4,mpegts,image2,pcm_s16le,null,segment,webp"
demuxers=""   # empty = leave every demuxer enabled

case "$target" in
    darwin-*) encoders="$encoders,h264_videotoolbox" ;;
    # Windows gets both hardware paths, because we do not know which GPU the
    # machine has: NVENC for NVIDIA, h264_qsv for Intel Quick Sync. Both are
    # loaded from the user's driver at run time, so carrying both costs a
    # compiled-in encoder each and nothing at all on a machine without them.
    # h264_amf for Radeon, h264_mf for everything else: the Media Foundation
    # encoder ships with every Windows install, so a machine with no usable GPU
    # at all still has an encoder that is not ours.
    win32-*) encoders="$encoders,h264_nvenc,h264_qsv,h264_amf,h264_mf" ;;
esac

configure_flags=(
    --prefix="$work/install"
    --pkg-config-flags=--static
    --extra-cflags="-I$prefix/include"
    --extra-ldflags="-L$prefix/lib"

    # Licensing: LGPL-2.1. --enable-gpl is what pulls in libx264 and makes the
    # result GPL, so dropping the software encoder is what buys the weaker
    # licence — that is the whole point of the exercise, not a side effect.
    # Never nonfree, which produces a binary FFmpeg itself calls
    # unredistributable; and no version3, which keeps this v2.1-or-later.
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

    # X11 is not optional by omission: configure auto-detects xlib and libxcb when
    # they are installed and links them. Nothing in a headless encoder wants an X
    # server, so they are disabled explicitly rather than left to whatever the build
    # machine happens to have.
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
        --enable-amf
        # Microsoft's own H.264 encoder, present on every Windows install. It is
        # the last resort in the fallback chain: slower and weaker than the GPU
        # encoders, and reportedly capped near 1080p, but it is the difference
        # between a GPU-less machine encoding badly and not encoding at all.
        --enable-mediafoundation

        # Intel Quick Sync, through the oneVPL dispatcher built above. libmfx is
        # the older route to the same encoders and FFmpeg refuses to have both;
        # libvpl is the one still maintained, and the one FFmpeg tells you to use.
        # This brings in the `qsv` hwaccel and the `*_qsv` filters as well as
        # h264_qsv, since filters are not narrowed in this build.
        --enable-libvpl

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
# Expect a few minutes natively and up to ~12 for the Windows cross-build: fewer
# cores, gcc rather than clang, and --enable-cuda-llvm compiling the CUDA kernels
# scale_cuda needs. The decoder set is deliberately complete, which is most of the
# ~2,000 objects.
#
# Every hundredth line is printed so the step can be seen progressing; silence for
# that long is indistinguishable from a hang.
(
    cd "$src"
    # PKG_CONFIG_LIBDIR, not PKG_CONFIG_PATH: LIBDIR *replaces* the default search
    # directories instead of adding to them, so the only libraries configure can
    # find are the ones we built. PATH was the reason the first macOS build picked
    # up Homebrew's libwebp — pkg-config searched /opt/homebrew regardless.
    export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
    ./configure "${configure_flags[@]}" >"$work/ffmpeg-configure.log" 2>&1 ||
        { tail -30 "$work/ffmpeg-configure.log"; fail "FFmpeg configure failed"; }
    # PIPESTATUS, because the exit status of a pipeline is the last command's —
    # piping make through awk would otherwise report success for a failed build.
    set -o pipefail
    make -j"$(nproc_cmd)" 2>&1 | tee "$work/ffmpeg-make.log" |
        awk 'NR % 100 == 0 { printf "    [%d objects] %s\n", NR, substr($0, 1, 60); fflush() }' ||
        { tail -30 "$work/ffmpeg-make.log"; fail "FFmpeg build failed"; }
)

# ── Install and report ───────────────────────────────────────────────────────
cp "$src/ffmpeg$exe" "$out/ffmpeg$exe"
cp "$src/ffprobe$exe" "$out/ffprobe$exe"
chmod 755 "$out/ffmpeg$exe" "$out/ffprobe$exe"

# ── Dependency audit ────────────────────────────────────────────────────────
log "Dependency audit"
# A binary that depends on libraries outside the OS set is not shippable: it runs
# here and fails on the user's machine. No functional test catches that, because the
# libraries are present wherever the testing happens — only an explicit check does.
#
# Audited one binary at a time, and never trusted on silence: each listing must
# contain a dependency that every real binary has (KERNEL32.dll / libSystem) before
# its emptiness means anything. `|| true` inside the substitutions keeps set -e from
# killing the assignment on a no-match grep, so the diagnostics below are reachable.
for audit_bin in "ffmpeg$exe" "ffprobe$exe"; do
    if [ "$os" = "mingw32" ]; then
        # Anchored to whole DLL names so a substring cannot wave through, say,
        # libfoo-uuid.dll on the strength of UUID.
        allowed='^(KERNEL32|USER32|GDI32|ADVAPI32|SHELL32|OLE32|OLEAUT32|PSAPI|BCRYPT|SECUR32|WS2_32|MSVCRT|IMM32|SETUPAPI|CFGMGR32|STRMIIDS|UUID|VERSION|DWMAPI|WINMM|SHLWAPI|MFPLAT|MF|MFUUID|D3D11|DXGI|USP10|RPCRT4|CRYPT32|NORMALIZ|NETAPI32|api-ms-win[-a-z0-9]*)\.dll$'
        imports="$("${cross_prefix}objdump" -p "$out/$audit_bin" 2>/dev/null |
            grep -i 'DLL Name:' | sed 's/.*DLL Name: *//' | sort -u || true)"
        grep -qiE '^KERNEL32\.dll$' <<<"$imports" ||
            fail "Could not read the import table of $out/$audit_bin.\n    Nothing about it has been checked. Is ${cross_prefix}objdump installed?"
        foreign="$(grep -viE "$allowed" <<<"$imports" || true)"
    else
        # @rpath/@loader_path/@executable_path count as foreign: they resolve to
        # something that has to travel beside the binary.
        links="$(otool -L "$out/$audit_bin" 2>/dev/null |
            grep -oE '^\s+[@/][^ ]+' | tr -d '\t ' | sort -u || true)"
        grep -qE '^/usr/lib/libSystem' <<<"$links" ||
            fail "Could not read the link table of $out/$audit_bin.\n    Nothing about it has been checked."
        foreign="$(grep -vE '^/usr/lib/|^/System/' <<<"$links" || true)"
    fi
    if [ -n "$foreign" ]; then
        printf '    %s\n' "$foreign" >&2
        fail "$audit_bin depends on libraries that will not be on the user's machine.
    Build the dependency statically instead of letting configure find a system copy."
    fi
done
echo "    ✓ no foreign dependencies — relocatable"

# ── Licence notice, written by the thing that did the building ───────────────
# Written here because only this script knows what went into the binary: which
# sources at which versions, and which GPL version applies. A notice that
# misdescribes what it accompanies is worse than none.
log "Licence notice"
# Read off the binary wherever it can be run, because a licence notice should
# describe the artefact rather than the intention. Without --enable-gpl this is
# LGPL-2.1-or-later, and the check below is what would catch a build that
# silently became something else — a reinstated --enable-gpl, or a component
# that dragged in version3.
licence="LGPL-2.1-or-later"
licence_texts="COPYING.LGPLv2.1 beside this file"
gpl_texts=(COPYING.LGPLv2.1)
if [ "$native" = true ]; then
    banner="$("$out/ffmpeg$exe" -hide_banner -L 2>/dev/null || true)"
    grep -q 'Lesser' <<<"$banner" ||
        fail "This build reports a GPL licence, not LGPL.\n    The licensing policy requires an LGPL build; check the configure flags."
    grep -q 'either version 3' <<<"$banner" &&
        fail "This build is v3-or-later. No --enable-version3 is passed here, so a\n    dependency has forced it; find which before shipping."
fi

nv_pin_line=""
vpl_pin_line=""
vpl_static_line=""
if [ "$os" = "mingw32" ]; then
    nv_pin_line="
  nv-codec-headers $NV_CODEC_HEADERS_TAG ($NV_CODEC_HEADERS_COMMIT)
    $NV_CODEC_HEADERS_REPO
  AMF $AMF_TAG ($AMF_COMMIT)
    $AMF_REPO"
    vpl_pin_line="
  libvpl $LIBVPL_TAG ($LIBVPL_COMMIT)
    $LIBVPL_REPO"
    # nv-codec-headers are headers and add nothing to the conveyed work; libvpl is
    # a library that ends up inside the binary, so it belongs in the list above too.
    vpl_static_line="
  libvpl    MIT — see LICENSE-libvpl.txt beside this file"
    cp "$vplsrc/LICENSE" "$out/LICENSE-libvpl.txt"
fi

# The LGPL text comes from the FFmpeg tarball itself rather than a copy we keep,
# so it is literally the licence the source shipped under. LGPL-2.1 s.6 asks for
# a copy to travel with the binary; a link is not one.
for licence_file in "${gpl_texts[@]}"; do
    from="$src/$licence_file"
    [ -f "$from" ] || fail "$licence_file is not in the FFmpeg source tree at $src"
    cp "$from" "$out/$licence_file"
done
# Any GPL texts left from an earlier build would now misdescribe this binary.
rm -f "$out"/GPL-*.txt

cat > "$out/LICENSE-ffmpeg.txt" <<EOF
FFmpeg $FFMPEG_VERSION ($target), built from source by this project, distributed
under the GNU Lesser General Public License version 2.1 or later.

No software H.264 encoder is included: this build carries no libx264, and
encoding uses an encoder already present on your machine (VideoToolbox on
macOS; NVENC, Quick Sync, AMF or Media Foundation on Windows).

This application invokes ffmpeg as a separate process; it is not linked against
the FFmpeg libraries. The application itself is licensed under Apache-2.0.

Licence:        $licence
Licence text:   $licence_texts
FFmpeg project: https://ffmpeg.org/

You may replace this ffmpeg with your own build. The application takes the one
beside it by default, and "Choose FFmpeg..." in its menu points it at any
directory holding an ffmpeg and ffprobe instead; setting FFMPEG_PATH and
FFPROBE_PATH in the environment does the same and takes precedence over both.

Statically linked, under their own terms:
  libwebp   BSD-3-Clause — see LICENSE-libwebp.txt beside this file$vpl_static_line

Corresponding source: this binary was built by ffmpeg-build/build.sh in the
Luminary Media Convert repository, from the sources pinned in
ffmpeg-build/versions.sh:

  FFmpeg $FFMPEG_VERSION   https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
    sha256 $FFMPEG_SHA256
  libwebp $LIBWEBP_VERSION
    sha256 $LIBWEBP_SHA256$nv_pin_line$vpl_pin_line

That script and versions file are the complete instructions for rebuilding this
binary, and for building a modified one to put in its place. No x264 and no
x265: this build writes H.264 only, using your machine's own encoder.

Substituting your own build: the application does not require the ffmpeg shipped
beside it. Choose FFmpeg… in the application menu points it at any directory
holding an ffmpeg and ffprobe, and it will use those instead after a restart.
Setting FFMPEG_PATH and FFPROBE_PATH in the environment does the same thing and
takes precedence over both.
EOF
cp "$webpsrc/COPYING" "$out/LICENSE-libwebp.txt"
notices="LICENSE-ffmpeg.txt ($licence), ${gpl_texts[*]}, LICENSE-libwebp.txt"
[ "$os" = "mingw32" ] && notices="$notices, LICENSE-libvpl.txt"
echo "    ✓ $notices"

# ── Build configuration, recorded beside the binary ──────────────────────────
# The licence gate in app-electron/scripts/verify-package.mjs reads this file.
# It has to be a file rather than a live `-buildconf`, because the Windows
# binary cannot be executed on the macOS machine that packages it, and a gate
# that quietly skips the cross-built target is not a gate.
log "Build configuration"
if [ "$native" = true ]; then
    "$out/ffmpeg$exe" -hide_banner -buildconf > "$out/BUILDCONF.txt"
else
    # Cross-built: the flags this script passed are the only evidence available.
    # Same shape configure echoes back, so the gate parses one format.
    {
        echo "  configuration:"
        printf '    %s\n' "${configure_flags[@]}"
    } > "$out/BUILDCONF.txt"
fi
echo "    ✓ BUILDCONF.txt"

log "Built $target"
for b in "ffmpeg$exe" "ffprobe$exe"; do
    printf '    %s  %s MB  %s\n' "$b" \
        "$(( $(filesize "$out/$b") / 1048576 ))" \
        "$(file -b "$out/$b")"
done

if [ "$native" = true ]; then
    # `|| true`: this is a report, not a check. What decides whether a build is
    # usable are the capability probes in CI and verify-package; failing the build
    # because a *description* could not be printed would be backwards.
    "$out/ffmpeg$exe" -hide_banner -version 2>/dev/null | head -1 | sed 's/^/    /' || true
    "$out/ffmpeg$exe" -hide_banner -L 2>/dev/null | sed -n '3p' | sed 's/^/    licence: /' || true
else
    echo "    (not run here: a $target binary cannot execute on $(uname -s)/$host_arch)"
fi
