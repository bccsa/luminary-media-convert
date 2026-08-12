# Corresponding source for the FFmpeg builds we ship

**Generated — do not edit by hand.** Run `npm -w electron run source-manifest`
after changing any pin in `electron/scripts/ffmpeg-targets.mjs`.

The GPL requires us to offer the source that rebuilds the binary we distribute.
x264 and x265 are **statically linked into** these executables, so their source at
the revisions used is part of the work being conveyed — not just FFmpeg's.
See [`ffmpeg-licensing.md`](ffmpeg-licensing.md) §5.

> **This file records what to publish. It is not itself the offer, and publishing
> has not happened yet** — until it does, distributing a build outside the
> organisation is not compliant (Todo 40).

## darwin-arm64

- **Builder**: osxexperts.net
- **Licence**: GPL-2.0-or-later (binary reports: either version 2)
- **FFmpeg**: ffmpeg version 8.1 Copyright (c) 2000-2026 the FFmpeg developers
- **x265**: `4.1+1-1d117be` (git describe, as the encoder reports it)
- **x264**: _not recoverable from the binary — ask the builder_

**Pinned downloads** (what the source must correspond to):

- `https://www.osxexperts.net/ffmpeg81arm.zip`
    - sha256 `ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad`
- `https://www.osxexperts.net/ffprobe81arm.zip`
    - sha256 `a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1`

**Configure line**

```
--prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check --arch=arm64 --cc=/usr/bin/clang --enable-gpl --enable-libvmaf --enable-libopenjpeg --enable-libopus --enable-libmp3lame --enable-libx264 --enable-libx265 --enable-libvvenc --enable-libvpx --enable-libwebp --enable-libass --enable-libfreetype --enable-fontconfig --enable-libtheora --enable-libvorbis --enable-libsnappy --enable-libaom --enable-libvidstab --enable-libzimg --enable-libsvtav1 --enable-libharfbuzz --enable-libkvazaar --pkg-config-flags=--static --enable-ffplay --enable-neon --enable-runtime-cpudetect --disable-indev=qtkit --disable-indev=x11grab_xcb
```

## darwin-x64

- **Builder**: osxexperts.net
- **Licence**: GPL-3.0-or-later (binary reports: either version 3)
- **FFmpeg**: ffmpeg version 8.0 Copyright (c) 2000-2025 the FFmpeg developers
- **x265**: `3.5+20-17839cc0d` (git describe, as the encoder reports it)
- **x264**: _not recoverable from the binary — ask the builder_

**Pinned downloads** (what the source must correspond to):

- `https://www.osxexperts.net/ffmpeg80intel.zip`
    - sha256 `2d24d22db78c87f394a5822867acd5c5dc5e762cd261a44bd26923f3a5af3e07`
- `https://www.osxexperts.net/ffprobe80intel.zip`
    - sha256 `0b6576104a95c1b39d4939e2df86f8f7cf1d55287ff57da48777d94605d12feb`

**Configure line**

```
--prefix=/Volumes/tempdisk/sw --extra-cflags=-fno-stack-check --arch=x86_64 --cc=/usr/bin/clang --enable-videotoolbox --enable-libfreetype --enable-fontconfig --enable-gpl --enable-libvmaf --enable-libopenjpeg --enable-libopus --enable-libtheora --enable-libvorbis --enable-libmp3lame --enable-libx264 --enable-libx265 --enable-libvvenc --enable-libvpx --enable-libwebp --enable-libass --enable-libaom --enable-libsnappy --enable-libvidstab --enable-libzimg --enable-libsvtav1 --enable-libharfbuzz --enable-ffplay --enable-version3 --pkg-config-flags=--static --enable-runtime-cpudetect --disable-filter=yadif_videotoolbox --disable-indev=qtkit --disable-indev=x11grab_xcb
```

## win32-x64

- **Builder**: BtbN (github.com/BtbN/FFmpeg-Builds)
- **Licence**: GPL-3.0-or-later (binary reports: either version 3 of the License)
- **FFmpeg**: n8.1.2-34-g9b6c8969e0-20260811
- **x265**: `4.2+37-b81f650e` (git describe, as the encoder reports it)
- **x264**: _not recoverable from the binary — ask the builder_

**Pinned downloads** (what the source must correspond to):

- `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-11-13-11/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip`
    - sha256 `05eedc113542be39af5d0f78f0b1093bafb89c98cecf25b77e8644670293107f`

**Configure line**

```
--prefix=/ffbuild/prefix --pkg-config-flags=--static --pkg-config=pkg-config --cross-prefix=x86_64-w64-mingw32- --arch=x86_64 --target-os=mingw32 --enable-gpl --enable-version3 --disable-debug --disable-w32threads --enable-pthreads --enable-iconv --enable-zlib --enable-libxml2 --enable-libvmaf --enable-fontconfig --enable-libharfbuzz --enable-libfreetype --enable-libfribidi --enable-vulkan --enable-libshaderc --enable-libvorbis --disable-libxcb --disable-xlib --disable-libpulse --enable-gmp --enable-lzma --enable-liblcevc-dec --enable-opencl --enable-amf --enable-libaom --enable-libaribb24 --enable-avisynth --enable-chromaprint --enable-libdav1d --enable-libdavs2 --enable-libdvdread --enable-libdvdnav --disable-libfdk-aac --enable-ffnvcodec --enable-cuda-llvm --enable-frei0r --enable-libgme --enable-libkvazaar --enable-libaribcaption --enable-libass --enable-libbluray --enable-libjxl --enable-libmp3lame --enable-libopus --enable-libplacebo --enable-librist --enable-libssh --enable-libtheora --enable-libvpx --enable-libwebp --enable-libzmq --enable-lv2 --enable-libvpl --enable-openal --enable-liboapv --enable-libopencore-amrnb --enable-libopencore-amrwb --enable-libopenh264 --enable-libopenjpeg --enable-libopenmpt --enable-librav1e --enable-librubberband --enable-schannel --enable-sdl2 --enable-libsnappy --enable-libsoxr --enable-libsrt --enable-libsvtav1 --enable-libtwolame --enable-libuavs3d --disable-libdrm --enable-vaapi --enable-libvidstab --enable-libvvenc --disable-whisper --enable-libx264 --enable-libx265 --enable-libxavs2 --enable-libxvid --enable-libzimg --enable-libzvbi --extra-cflags=-DLIBTWOLAME_STATIC --extra-cxxflags= --extra-libs=-lgomp --extra-ldflags=-pthread --extra-ldexeflags= --cc=x86_64-w64-mingw32-gcc --cxx=x86_64-w64-mingw32-g++ --ar=x86_64-w64-mingw32-gcc-ar --ranlib=x86_64-w64-mingw32-gcc-ranlib --nm=x86_64-w64-mingw32-gcc-nm --extra-version=20260811
```

## What is still missing, and how to close it

**x264's revision is not recoverable from any of these builds.** It is absent from
the encoder log, from the muxer metadata, and from the embedded strings — unlike
x265, which prints a git-describe string. So the exact x264 source cannot be
identified from what we hold.

Two ways forward:

1. **Ask each builder.** BtbN publishes the build scripts behind their releases,
   which pin the dependency revisions; osxexperts.net documents nothing, so it
   would have to be a direct question.
2. **Build FFmpeg ourselves**, which makes the corresponding source ours by
   construction and removes the question — at the cost of maintaining three
   builds and their security updates.

Until one of those happens, the honest position is the one in the shipped notice:
the corresponding source for these exact builds is not published.
