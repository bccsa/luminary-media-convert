import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    type Settings,
    defaultSettings,
    loadSettings,
    saveSettings,
} from './settings';

describe('settings', () => {
    let dir: string;
    let path: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lmc-settings-'));
        path = join(dir, 'settings.json');
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('starts a first run trusting nothing, on the bundled ffmpeg', async () => {
        expect(await loadSettings(path)).toEqual(defaultSettings());
        expect(defaultSettings()).toEqual({
            allowedOrigins: [],
            deniedOrigins: [],
            ffmpegDir: null,
            skippedVersion: null,
        });
    });

    it('reads back what it saved', async () => {
        const saved: Settings = {
            allowedOrigins: ['https://cms.example.org'],
            deniedOrigins: ['https://evil.example.com'],
            ffmpegDir: '/opt/ffmpeg',
            skippedVersion: '0.0.8',
        };
        await saveSettings(path, saved, () => {});
        expect(await loadSettings(path)).toEqual(saved);
    });

    it('creates the directory it saves into', async () => {
        const nested = join(dir, 'User Data', 'settings.json');
        await saveSettings(nested, defaultSettings(), () => {});
        expect(JSON.parse(await readFile(nested, 'utf8'))).toEqual(
            defaultSettings()
        );
    });

    it('trusts nothing again when the file is not JSON', async () => {
        await writeFile(path, '{"allowedOrigins": ["https://cms.exa', 'utf8');
        expect(await loadSettings(path)).toEqual(defaultSettings());
    });

    it('trusts nothing again when the file holds something other than an object', async () => {
        await writeFile(path, '["https://cms.example.org"]', 'utf8');
        expect((await loadSettings(path)).allowedOrigins).toEqual([]);
        await writeFile(path, 'null', 'utf8');
        expect(await loadSettings(path)).toEqual(defaultSettings());
    });

    it('keeps the fields a partial file has and starts the rest fresh', async () => {
        await writeFile(
            path,
            JSON.stringify({ allowedOrigins: ['https://cms.example.org'] }),
            'utf8'
        );
        expect(await loadSettings(path)).toEqual({
            ...defaultSettings(),
            allowedOrigins: ['https://cms.example.org'],
        });
    });

    it('ignores a field of the wrong type rather than trusting it', async () => {
        await writeFile(
            path,
            JSON.stringify({
                allowedOrigins: 'https://cms.example.org',
                deniedOrigins: ['https://a.example', 7],
                ffmpegDir: 42,
            }),
            'utf8'
        );
        expect(await loadSettings(path)).toEqual({
            ...defaultSettings(),
            deniedOrigins: ['https://a.example'],
        });
    });

    it('reports a save it could not make instead of throwing', async () => {
        // A file where the directory should be: mkdir cannot make it.
        await writeFile(join(dir, 'blocked'), '', 'utf8');
        const onError = vi.fn();
        await expect(
            saveSettings(
                join(dir, 'blocked', 'settings.json'),
                defaultSettings(),
                onError
            )
        ).resolves.toBeUndefined();
        expect(onError).toHaveBeenCalledTimes(1);
    });
});
