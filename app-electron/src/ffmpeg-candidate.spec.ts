import { describe, expect, it } from 'vitest';
import { checkCandidate } from './ffmpeg-candidate';

const candidate = { ffmpeg: '/picked/ffmpeg', ffprobe: '/picked/ffprobe' };

describe('checkCandidate', () => {
    it('runs the check with the candidate in the environment', async () => {
        const env: NodeJS.ProcessEnv = {};
        const seen = await checkCandidate(env, candidate, async () => ({
            ffmpeg: env.FFMPEG_PATH,
            ffprobe: env.FFPROBE_PATH,
        }));
        expect(seen).toEqual({
            ffmpeg: '/picked/ffmpeg',
            ffprobe: '/picked/ffprobe',
        });
    });

    it('puts back the paths the API was using', async () => {
        const env: NodeJS.ProcessEnv = {
            FFMPEG_PATH: '/bundled/ffmpeg',
            FFPROBE_PATH: '/bundled/ffprobe',
        };
        await checkCandidate(env, candidate, async () => ({
            reason: 'too old',
        }));
        expect(env.FFMPEG_PATH).toBe('/bundled/ffmpeg');
        expect(env.FFPROBE_PATH).toBe('/bundled/ffprobe');
    });

    it('removes them again when they were not set', async () => {
        const env: NodeJS.ProcessEnv = {};
        await checkCandidate(env, candidate, async () => null);
        expect('FFMPEG_PATH' in env).toBe(false);
        expect('FFPROBE_PATH' in env).toBe(false);
    });

    it('puts them back when the check throws', async () => {
        const env: NodeJS.ProcessEnv = { FFMPEG_PATH: '/bundled/ffmpeg' };
        await expect(
            checkCandidate(env, candidate, async () => {
                throw new Error('ffmpeg did not start');
            })
        ).rejects.toThrow('ffmpeg did not start');
        expect(env.FFMPEG_PATH).toBe('/bundled/ffmpeg');
        expect('FFPROBE_PATH' in env).toBe(false);
    });
});
