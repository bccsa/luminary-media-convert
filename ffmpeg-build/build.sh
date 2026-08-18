#!/usr/bin/env bash
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

# ── x264, pinned to a commit ─────────────────────────────────────────────────
log "x264 $X264_COMMIT"
x264src="$work/x264"
if [ ! -d "$x264src/.git" ]; then
    git clone -q "$X264_REPO" "$x264src"
fi
git -C "$x264src" fetch -q origin
git -C "$x264src" checkout -q "$X264_COMMIT"

# Keyed to the pin, not merely to the file's existence: a bumped X264_COMMIT with a
# leftover .a in $prefix would otherwise link the previous revision while the licence
# notice attests the new one.
x264_stamp="$prefix/.x264-$X264_COMMIT"
if [ ! -f "$x264_stamp" ]; then
    # Invalidate first, stamp only after success: a failed build must leave neither
    # the old library nor any stamp, or a later revert of the pin would skip a
    # rebuild it needs.
    rm -f "$prefix"/.x264-* "$prefix/lib/libx264.a"
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
    touch "$x264_stamp"
fi
echo "    ✓ libx264.a"

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
encoders="libx264,aac,libwebp,mjpeg,pcm_s16le"
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
    win32-*) encoders="$encoders,h264_nvenc,h264_qsv" ;;
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
# 2 unless the binary says otherwise. This build never passes --enable-version3, so
# 2 is the right answer — but it is read off the binary where that is possible,
# because a licence notice should describe the artefact rather than the intention.
# On a cross-built target that cannot be run here, the configure flags are the only
# evidence available, and they are in this file.
licence_version="2"
if [ "$native" = true ]; then
    "$out/ffmpeg$exe" -hide_banner -L 2>/dev/null | grep -q 'either version 3' &&
        licence_version="3"
fi

# A v2-or-later work offers v3 as well, so both texts travel; a v3-or-later one
# offers only v3.
if [ "$licence_version" = "3" ]; then
    gpl_texts=(GPL-3.0.txt)
    licence_texts="GPL-3.0.txt"
else
    gpl_texts=(GPL-2.0.txt GPL-3.0.txt)
    licence_texts="GPL-2.0.txt (and GPL-3.0.txt, at your option)"
fi

nv_pin_line=""
vpl_pin_line=""
vpl_static_line=""
if [ "$os" = "mingw32" ]; then
    nv_pin_line="
  nv-codec-headers $NV_CODEC_HEADERS_TAG ($NV_CODEC_HEADERS_COMMIT)
    $NV_CODEC_HEADERS_REPO"
    vpl_pin_line="
  libvpl $LIBVPL_TAG ($LIBVPL_COMMIT)
    $LIBVPL_REPO"
    # nv-codec-headers are headers and add nothing to the conveyed work; libvpl is
    # a library that ends up inside the binary, so it belongs in the list above too.
    vpl_static_line="
  libvpl    MIT — see LICENSE-libvpl.txt beside this file"
    cp "$vplsrc/LICENSE" "$out/LICENSE-libvpl.txt"
fi

for licence in "${gpl_texts[@]}"; do
    from="$repo/app-electron/bin/licenses/$licence"
    [ -f "$from" ] || fail "$licence is missing from app-electron/bin/licenses/"
    # A v2-or-later work offers v3 as well, so both travel. (A v3-only build would
    # ship v3 alone.)
    cp "$from" "$out/$licence"
done

cat > "$out/LICENSE-ffmpeg.txt" <<EOF
FFmpeg $FFMPEG_VERSION ($target), built from source by this project, distributed
under the GNU General Public License version $licence_version or later, with
libx264 statically linked.

This application invokes ffmpeg as a separate process; it is not linked against
the FFmpeg libraries. The application itself is licensed under Apache-2.0.

Licence:        GPL-$licence_version.0-or-later
Licence text:   $licence_texts beside this file
FFmpeg project: https://ffmpeg.org/

Statically linked, under their own terms:
  libx264   GPL-2.0-or-later, covered by the GPL text above
  libwebp   BSD-3-Clause — see LICENSE-libwebp.txt beside this file$vpl_static_line

Corresponding source: this binary was built by ffmpeg-build/build.sh in the
Luminary Media Convert repository, from the sources pinned in
ffmpeg-build/versions.sh:

  FFmpeg $FFMPEG_VERSION   https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz
    sha256 $FFMPEG_SHA256
  x264      $X264_COMMIT
    $X264_REPO
  libwebp $LIBWEBP_VERSION
    sha256 $LIBWEBP_SHA256$nv_pin_line$vpl_pin_line

That script and versions file are the complete instructions for rebuilding this
binary. No x265: this build writes H.264 only.
EOF
cp "$webpsrc/COPYING" "$out/LICENSE-libwebp.txt"
notices="LICENSE-ffmpeg.txt (GPL-$licence_version.0-or-later), ${gpl_texts[*]}, LICENSE-libwebp.txt"
[ "$os" = "mingw32" ] && notices="$notices, LICENSE-libvpl.txt"
echo "    ✓ $notices"

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
