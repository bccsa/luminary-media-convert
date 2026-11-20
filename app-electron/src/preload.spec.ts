import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import './preload';

/**
 * The preload is the renderer's whole access to the machine, so what it exposes
 * is pinned here: the exact calls, the channels behind them, and that each
 * channel is answered in main.ts and declared for the UI in app/env.d.ts.
 */

const electron = vi.hoisted(() => ({
    exposed: {} as Record<string, unknown>,
    invoke: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getPathForFile: vi.fn(),
}));

vi.mock('electron', () => ({
    contextBridge: {
        exposeInMainWorld: (key: string, api: Record<string, unknown>) => {
            electron.exposed[key] = api;
        },
    },
    ipcRenderer: {
        invoke: electron.invoke,
        on: electron.on,
        off: electron.off,
    },
    webUtils: { getPathForFile: electron.getPathForFile },
}));

type Bridge = {
    getApiToken: () => Promise<string>;
    getPathForFile: (file: File) => string;
    showOpenDialog: () => Promise<string | null>;
    onShowSession: (handler: (sessionId: string) => void) => () => void;
    takePendingSession: () => Promise<string | null>;
};

const source = (...path: string[]) =>
    readFileSync(join(__dirname, '..', ...path), 'utf8');

describe('the preload bridge', () => {
    let bridge: Bridge;

    beforeAll(() => {
        bridge = electron.exposed.luminary as Bridge;
    });

    beforeEach(() => {
        electron.invoke.mockReset();
        electron.on.mockReset();
        electron.off.mockReset();
        electron.getPathForFile.mockReset();
    });

    it('exposes window.luminary and nothing else', () => {
        expect(Object.keys(electron.exposed)).toEqual(['luminary']);
    });

    it('offers exactly the five calls, so a new one has to be added here on purpose', () => {
        expect(Object.keys(bridge).sort()).toEqual([
            'getApiToken',
            'getPathForFile',
            'onShowSession',
            'showOpenDialog',
            'takePendingSession',
        ]);
    });

    it('asks the main process on its channel for the token, the picker and the pending session', async () => {
        electron.invoke.mockResolvedValue('answer');

        await bridge.getApiToken();
        await bridge.showOpenDialog();
        await bridge.takePendingSession();

        expect(electron.invoke.mock.calls).toEqual([
            ['luminary:getApiToken'],
            ['luminary:showOpenDialog'],
            ['luminary:takePendingSession'],
        ]);
    });

    it('passes on what the main process answers', async () => {
        electron.invoke.mockResolvedValueOnce('/Videos/meeting.mp4');
        await expect(bridge.showOpenDialog()).resolves.toBe(
            '/Videos/meeting.mp4'
        );

        electron.invoke.mockResolvedValueOnce(null);
        await expect(bridge.showOpenDialog()).resolves.toBeNull();
    });

    it("gets a dropped file's path from Electron and does nothing else with it", () => {
        const file = { name: 'meeting.mp4' } as File;
        electron.getPathForFile.mockReturnValue('/Videos/meeting.mp4');

        expect(bridge.getPathForFile(file)).toBe('/Videos/meeting.mp4');
        expect(electron.getPathForFile).toHaveBeenCalledWith(file);
        expect(electron.invoke).not.toHaveBeenCalled();
    });

    it('hands a session the CMS opened to the handler, and stops when unsubscribed', () => {
        const handler = vi.fn();

        const unsubscribe = bridge.onShowSession(handler);
        const [channel, listener] = electron.on.mock.calls[0];
        listener({}, 'session-42');

        expect(channel).toBe('luminary:showSession');
        expect(handler).toHaveBeenCalledWith('session-42');

        unsubscribe();
        expect(electron.off).toHaveBeenCalledWith(
            'luminary:showSession',
            listener
        );
    });

    it('uses only channels the main process answers or sends', () => {
        const main = source('src', 'main.ts');
        const preload = source('src', 'preload.ts');
        const channels = [...preload.matchAll(/'(luminary:[A-Za-z]+)'/g)].map(
            (m) => m[1]
        );

        expect(channels.length).toBeGreaterThan(0);
        for (const channel of channels)
            expect(
                main.includes(`ipcMain.handle('${channel}'`) ||
                    main.includes(`send('${channel}'`),
                channel
            ).toBe(true);
    });

    it('matches the calls the UI declares for window.luminary', () => {
        const env = source('..', 'app', 'env.d.ts');
        const block =
            env.match(/interface LuminaryBridge \{([\s\S]*?)\n\}/)?.[1] ?? '';
        const declared = [...block.matchAll(/^\s{4}(\w+)\(/gm)].map(
            (m) => m[1]
        );

        expect(declared.sort()).toEqual(Object.keys(bridge).sort());
    });
});
