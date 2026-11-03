import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_FILE, PREVIOUS_LOG_FILE, teeConsoleToFile } from './log-file';

describe('teeConsoleToFile', () => {
    let dir: string;
    const stream = () => ({ write: vi.fn().mockReturnValue(true) });

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'lmc-log-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('copies what reaches the console into the file, and still passes it on', () => {
        const out = stream();
        const original = out.write;
        const path = teeConsoleToFile(dir, { streams: [out] });

        out.write('Encoding API listening\n');
        out.write(Buffer.from('a buffer too\n'));

        expect(original).toHaveBeenCalledWith('Encoding API listening\n');
        expect(readFileSync(path, 'utf8')).toBe(
            'Encoding API listening\na buffer too\n'
        );
    });

    it('keeps logging to the file when the console it copies has gone', () => {
        // The terminal that started the app closed: every console write fails.
        const listeners: ((err: Error) => void)[] = [];
        const broken = {
            write: vi.fn((_chunk: unknown) => {
                throw Object.assign(new Error('write EPIPE'), {
                    code: 'EPIPE',
                });
            }),
            on: vi.fn((_event: 'error', listener: (err: Error) => void) => {
                listeners.push(listener);
            }),
        };
        const path = teeConsoleToFile(dir, { streams: [broken] });

        expect(() => broken.write('still recorded\n')).not.toThrow();
        // And an EPIPE the stream reports later, as an event, is handled.
        expect(listeners).toHaveLength(1);
        expect(() => listeners[0]!(new Error('write EPIPE'))).not.toThrow();
        expect(readFileSync(path, 'utf8')).toBe('still recorded\n');
    });

    it('leaves the terminal colours out of the file', () => {
        const out = stream();
        const path = teeConsoleToFile(dir, { streams: [out] });

        out.write('\x1b[32m[Nest] 123  - \x1b[39mLOG\n');

        expect(readFileSync(path, 'utf8')).toBe('[Nest] 123  - LOG\n');
    });

    it('starts a new file once it is full, keeping the one before', () => {
        const out = stream();
        const path = teeConsoleToFile(dir, { maxBytes: 10, streams: [out] });

        out.write('0123456789'); // fills it
        out.write('next\n');

        expect(readFileSync(join(dir, PREVIOUS_LOG_FILE), 'utf8')).toBe(
            '0123456789'
        );
        expect(readFileSync(path, 'utf8')).toBe('next\n');
    });

    it('carries on from the last launch until that file is full', () => {
        writeFileSync(join(dir, LOG_FILE), 'last launch\n');
        const out = stream();
        const path = teeConsoleToFile(dir, { streams: [out] });

        out.write('this launch\n');

        expect(readFileSync(path, 'utf8')).toBe('last launch\nthis launch\n');
    });
});
