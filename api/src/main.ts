import dotenv from 'dotenv';
import { createServer, DEFAULT_HOST } from './bootstrap.js';
import { applyDevDefaults } from './dev-defaults.js';

dotenv.config();
// After dotenv, so a real `.env` always wins, and before `createServer`,
// because the providers read these from the environment at module init.
applyDevDefaults();

/**
 * The API on its own, configured by its environment.
 *
 * Everything it does is in `bootstrap.ts`; this file exists so that running
 * the service directly and embedding it in the desktop app are the same code
 * path with different arguments. `LOCAL_API_TOKEN`, `WORK_DIR`,
 * `CMS_ALLOWED_ORIGINS` and the ffmpeg paths are read by the providers and
 * services themselves, so they are deliberately not repeated here.
 */
async function main(): Promise<void> {
    const { url } = await createServer({
        port: Number(process.env.PORT ?? 3000),
        host: process.env.HOST ?? DEFAULT_HOST,
        enableSwagger: true,
    });

    console.log(`Luminary Media Convert running on ${url}`);
    console.log(`API docs available at ${url}/api/docs`);
}

main();
