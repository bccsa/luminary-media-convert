/**
 * Where ffmpeg and ffprobe live.
 *
 * Standalone, they are whatever the shell would find: the developer installed
 * them, and PATH is the answer. The packaged desktop app ships its own builds
 * next to the executable, because a user who downloaded a video converter has
 * not also installed a media toolchain, and the one they might have could be
 * any version with any set of encoders compiled in.
 *
 * Read from the environment on every call rather than captured once, so the
 * embedding host can set them before Nest instantiates anything and services
 * constructed at any point afterwards all agree.
 */

/** The ffmpeg executable to spawn: `FFMPEG_PATH`, else PATH lookup. */
export const ffmpegBin = (): string => process.env.FFMPEG_PATH || 'ffmpeg';

/** The ffprobe executable to spawn: `FFPROBE_PATH`, else PATH lookup. */
export const ffprobeBin = (): string => process.env.FFPROBE_PATH || 'ffprobe';

/**
 * The same binary, safe to paste into a shell command string.
 *
 * `execFile` takes the path as an argument and needs none of this; the couple
 * of capability probes that go through `execSync` do, and an installation path
 * with a space in it — `/Applications/Luminary Media Convert.app/...` on a Mac,
 * always — would otherwise be read as a command plus an argument.
 */
export const shellQuote = (bin: string): string =>
    /[\s"'$`\\]/.test(bin) ? `"${bin.replace(/(["$`\\])/g, '\\$1')}"` : bin;

/** {@link ffmpegBin} quoted for a shell command line. */
export const ffmpegShellBin = (): string => shellQuote(ffmpegBin());
