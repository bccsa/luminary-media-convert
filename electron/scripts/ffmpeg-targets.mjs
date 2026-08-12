#!/usr/bin/env node
/**
 * The pinned FFmpeg builds, as data.
 *
 * A module of its own because two scripts need it and neither should own it:
 * `fetch-binaries.mjs` downloads and verifies these, and `check-pinned-urls.mjs`
 * asks weekly whether they still exist. A second copy of the URLs would drift,
 * and a health check watching stale URLs is worse than no health check.
 */

/**
 * One entry per platform the app is built for.
 *
 * Both macOS builds come from osxexperts.net, which publishes arm64 and Intel
 * from the same hand — so the two Macs differ only in architecture, not in
 * provenance. evermeet.cx would also serve Intel, and Homebrew's build is not a
 * candidate at all: it links against eighteen dylibs under /opt/homebrew and
 * cannot start anywhere else.
 *
 * There is no 32-bit Windows entry, because no maintained FFmpeg build exists
 * for it — BtbN publishes win64 only, gyan.dev is 64-bit only, and Zeranoe (the
 * last 32-bit publisher) shut down in 2020. See docs/ffmpeg-licensing.md.
 *
 * These are GPL builds, and deliberately. The LGPL ones omit libx264, which is
 * the CPU fallback in FfmpegService — without it the app cannot encode at all
 * on a machine with no VideoToolbox or NVENC. ffmpeg runs as a separate
 * process, never linked, so the obligation travels with ffmpeg rather than
 * with this Apache-2.0 codebase; LICENSE-ffmpeg.txt is written beside the
 * binaries and shipped with them.
 *
 * `builder` and `licence` are per target and must be read off each binary, never
 * assumed across platforms: `ffmpeg -L` reports the version and `-buildconf`
 * shows whether `--enable-version3` was set. They genuinely differ here — the
 * arm64 build is v2-or-later, while the Intel and Windows builds enable
 * version3 and are v3-or-later. One shared string had been claiming v2 for all
 * three, and crediting osxexperts.net for the Windows build BtbN produced.
 */
export const TARGETS = {
    'darwin-arm64': {
        version: '8.1',
        arch: 'arm64',
        builder: 'osxexperts.net',
        // `ffmpeg -L` says version 2, and `-buildconf` has no `--enable-version3`.
        licence: 'GPL-2.0-or-later',
        /**
         * One entry per archive, each naming what it provides. macOS ships the
         * two binaries separately; Windows ships both in one 160 MB zip, so the
         * shape has to allow either without downloading the same archive twice.
         */
        archives: [
            {
                url: 'https://www.osxexperts.net/ffmpeg81arm.zip',
                sha256: 'ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad',
                provides: [{ name: 'ffmpeg', from: 'ffmpeg' }],
            },
            {
                url: 'https://www.osxexperts.net/ffprobe81arm.zip',
                sha256: 'a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1',
                provides: [{ name: 'ffprobe', from: 'ffprobe' }],
            },
        ],
        /**
         * What the app actually asks of this build. Checked after unpacking,
         * because a binary that downloads and unzips cleanly can still be the
         * wrong architecture or missing the encoder the whole bundle is for.
         *
         * Only ffmpeg is asked about codecs: ffprobe inspects media and does
         * not take `-hwaccels`, `-encoders` or `-filters` at all.
         */
        verify: {
            ffmpeg: {
                hwaccel: 'videotoolbox',
                encoders: ['h264_videotoolbox', 'libx264'],
                filters: ['scale_vt'],
            },
        },
    },

    /**
     * macOS Intel. Same builder as arm64, a different FFmpeg version (8.0 is the
     * newest Intel build published there), and a *different licence*: this one is
     * configured `--enable-version3`, so it is v3-or-later.
     *
     * Needed because an Intel Mac cannot run the arm64 binary at all — with no
     * entry here the resolver finds nothing, falls through to PATH and shows the
     * install prompt that embedding exists to remove.
     */
    'darwin-x64': {
        version: '8.0',
        // What architectureOf() reports for a Mach-O x86_64 binary — the same
        // spelling it uses for a 64-bit PE, so the two x64 targets agree.
        arch: 'x86-64',
        builder: 'osxexperts.net',
        licence: 'GPL-3.0-or-later',
        archives: [
            {
                url: 'https://www.osxexperts.net/ffmpeg80intel.zip',
                sha256: '2d24d22db78c87f394a5822867acd5c5dc5e762cd261a44bd26923f3a5af3e07',
                provides: [{ name: 'ffmpeg', from: 'ffmpeg' }],
            },
            {
                url: 'https://www.osxexperts.net/ffprobe80intel.zip',
                sha256: '0b6576104a95c1b39d4939e2df86f8f7cf1d55287ff57da48777d94605d12feb',
                provides: [{ name: 'ffprobe', from: 'ffprobe' }],
            },
        ],
        /*
         * Same requirements as arm64: VideoToolbox is present on Intel Macs too
         * (it is the T2/Quick Sync path there rather than the Apple Silicon
         * media engine), and libx264 is the fallback when the encoder is absent
         * or refuses the profile.
         */
        verify: {
            ffmpeg: {
                hwaccel: 'videotoolbox',
                encoders: ['h264_videotoolbox', 'libx264'],
                filters: ['scale_vt'],
            },
        },
    },

    /**
     * Windows, pinned to a dated BtbN release rather than their `latest` tag —
     * `latest` moves, and a moving URL cannot be pinned to a digest.
     *
     * The `-gpl` build rather than `-gpl-shared`: shared means DLLs beside the
     * executable, and `bundledBinary()` resolves a single file. Same reasoning
     * that ruled out Homebrew on macOS.
     */
    'win32-x64': {
        version: '8.1.2',
        // What `file` reports for a 64-bit PE executable.
        arch: 'x86-64',
        builder: 'BtbN (github.com/BtbN/FFmpeg-Builds)',
        // Configured `--enable-version3`, and `-L` prints version 3 — confirmed
        // on the Windows runner, since a .exe cannot be run to ask here.
        licence: 'GPL-3.0-or-later',
        archives: [
            {
                url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-11-13-11/ffmpeg-n8.1.2-34-g9b6c8969e0-win64-gpl-8.1.zip',
                sha256: '05eedc113542be39af5d0f78f0b1093bafb89c98cecf25b77e8644670293107f',
                provides: [
                    { name: 'ffmpeg.exe', from: '*/bin/ffmpeg.exe' },
                    { name: 'ffprobe.exe', from: '*/bin/ffprobe.exe' },
                ],
            },
        ],
        verify: {
            'ffmpeg.exe': {
                hwaccel: 'cuda',
                encoders: ['h264_nvenc', 'libx264'],
                filters: ['scale_cuda'],
            },
        },
    },
};
