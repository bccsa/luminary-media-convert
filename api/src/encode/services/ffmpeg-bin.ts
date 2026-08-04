/**
 * Where to find ffmpeg and ffprobe.
 *
 * Server deployments install them system-wide, so the bare names resolve off
 * PATH and nothing needs configuring. The desktop build cannot rely on that: a
 * GUI-launched app inherits almost none of the user's shell environment, so on
 * macOS a Homebrew ffmpeg in /opt/homebrew/bin is invisible even though it
 * works fine in a terminal. There the shell locates the binaries and passes
 * absolute paths in.
 *
 * Read once at module load — the process is launched with these already set.
 */
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
export const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
