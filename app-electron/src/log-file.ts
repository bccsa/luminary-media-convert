/**
 * A log file of everything the app writes to its console.
 *
 * The encoder logs to stdout, which on an installed app goes nowhere anyone can
 * read: a fault on a Windows machine nobody here can see left nothing behind to
 * say what happened. Every write to the console now also lands in a file, while
 * still reaching the console as before.
 *
 * Kept free of Electron so it can be tested; `main.ts` supplies the directory.
 */
import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    renameSync,
    statSync,
    writeSync,
} from 'node:fs';
import { join } from 'node:path';

export const LOG_FILE = 'main.log';
/** The file before the current one, kept so a restart does not lose the fault it followed. */
export const PREVIOUS_LOG_FILE = 'main.old.log';
const MAX_BYTES = 5 * 1024 * 1024;
/** Terminal colours: noise in a file. */
const ANSI = /\x1b\[[0-9;]*m/g;

type Writable = Pick<NodeJS.WriteStream, 'write'>;

/**
 * Copy every write to `streams` into `<dir>/main.log`, starting a new file when
 * it passes `maxBytes` and keeping the one before it. Returns the log's path.
 */
export function teeConsoleToFile(
    dir: string,
    opts: { maxBytes?: number; streams?: Writable[] } = {}
): string {
    const maxBytes = opts.maxBytes ?? MAX_BYTES;
    const path = join(dir, LOG_FILE);
    const previous = join(dir, PREVIOUS_LOG_FILE);
    mkdirSync(dir, { recursive: true });

    let size = existsSync(path) ? statSync(path).size : 0;
    let fd: number | null = null;
    const rotate = () => {
        if (fd !== null) closeSync(fd);
        renameSync(path, previous);
        fd = openSync(path, 'a');
        size = 0;
    };
    fd = openSync(path, 'a');
    // Each launch starts on a fresh file once the last one is big enough to
    // be worth keeping whole.
    if (size >= maxBytes) rotate();

    const record = (chunk: unknown) => {
        const text = (
            typeof chunk === 'string'
                ? chunk
                : Buffer.from(chunk as Uint8Array).toString('utf8')
        ).replace(ANSI, '');
        // Written synchronously, so the line before a crash is in the file.
        size += writeSync(fd!, text);
        if (size >= maxBytes) rotate();
    };

    for (const stream of opts.streams ?? [process.stdout, process.stderr]) {
        const write = stream.write.bind(stream) as (
            ...args: unknown[]
        ) => boolean;
        stream.write = ((chunk: unknown, ...rest: unknown[]) => {
            try {
                record(chunk);
            } catch {
                // A log that cannot be written must not take the app down with it.
            }
            return write(chunk, ...rest);
        }) as Writable['write'];
    }
    return path;
}
