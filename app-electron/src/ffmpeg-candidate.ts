/**
 * Checking an FFmpeg the user picked before switching to it.
 *
 * The check the app runs on its own binary at startup reads FFMPEG_PATH and
 * FFPROBE_PATH, so a candidate is checked by pointing those at it for the
 * length of the check. The running API reads the same variables: they must be
 * put back afterwards, whatever the check did, or the API would be left on a
 * binary the user may have just been told is unusable.
 *
 * Kept apart from main.ts so that promise can be tested without Electron.
 */
export async function checkCandidate<T>(
    env: NodeJS.ProcessEnv,
    candidate: { ffmpeg: string; ffprobe: string },
    check: () => Promise<T>
): Promise<T> {
    const before = {
        FFMPEG_PATH: env.FFMPEG_PATH,
        FFPROBE_PATH: env.FFPROBE_PATH,
    };
    try {
        env.FFMPEG_PATH = candidate.ffmpeg;
        env.FFPROBE_PATH = candidate.ffprobe;
        return await check();
    } finally {
        // Including nothing: a variable that was unset is removed again, not
        // left as an empty string the lookup would treat as a path.
        for (const [key, value] of Object.entries(before)) {
            if (value === undefined) delete env[key];
            else env[key] = value;
        }
    }
}
