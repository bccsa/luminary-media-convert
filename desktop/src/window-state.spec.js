import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WindowState, MIN_WIDTH, MIN_HEIGHT } from './window-state.js';

/** A single 1920x1080 display at the origin, minus a menu bar. */
const ONE_DISPLAY = {
    getAllDisplays: () => [
        { workArea: { x: 0, y: 25, width: 1920, height: 1055 } },
    ],
};

describe('WindowState', () => {
    let dir;
    let path;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'window-state-'));
        path = join(dir, 'window-state.json');
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    function save(state) {
        writeFileSync(path, JSON.stringify(state));
    }

    describe('first run', () => {
        it('opens large enough for the session view', () => {
            const bounds = new WindowState(path, ONE_DISPLAY).bounds();
            expect(bounds.width).toBeGreaterThanOrEqual(1280);
            expect(bounds.height).toBeGreaterThanOrEqual(800);
        });

        it('lets the window manager place it', () => {
            const bounds = new WindowState(path, ONE_DISPLAY).bounds();
            expect(bounds.x).toBeUndefined();
            expect(bounds.y).toBeUndefined();
        });

        it('always sets a floor, so the layout cannot be crushed', () => {
            const bounds = new WindowState(path, ONE_DISPLAY).bounds();
            expect(bounds.minWidth).toBe(MIN_WIDTH);
            expect(bounds.minHeight).toBe(MIN_HEIGHT);
        });
    });

    describe('restoring', () => {
        it('reuses a size and position that still fit a display', () => {
            save({ width: 1000, height: 700, x: 120, y: 80 });
            expect(new WindowState(path, ONE_DISPLAY).bounds()).toMatchObject({
                width: 1000,
                height: 700,
                x: 120,
                y: 80,
            });
        });

        it('remembers that the window was maximized', () => {
            save({ width: 1000, height: 700, maximized: true });
            expect(new WindowState(path, ONE_DISPLAY).startMaximized).toBe(true);
        });

        it('raises a stored size that is below the minimum', () => {
            save({ width: 300, height: 200 });
            const bounds = new WindowState(path, ONE_DISPLAY).bounds();
            expect(bounds.width).toBe(MIN_WIDTH);
            expect(bounds.height).toBe(MIN_HEIGHT);
        });
    });

    describe('a display that is no longer there', () => {
        // The failure this prevents is indistinguishable from the app not
        // starting: the window opens at coordinates no screen covers, and
        // nothing appears.
        it.each([
            ['to the right of every display', { x: 3000, y: 100 }],
            ['below every display', { x: 100, y: 4000 }],
            ['on a display that was to the left', { x: -1600, y: 100 }],
        ])('drops a position %s', (_label, position) => {
            save({ width: 1000, height: 700, ...position });
            const bounds = new WindowState(path, ONE_DISPLAY).bounds();
            expect(bounds.x).toBeUndefined();
            expect(bounds.y).toBeUndefined();
            // The size is still worth keeping — only the position was wrong.
            expect(bounds.width).toBe(1000);
        });

        it('keeps a position once the display comes back', () => {
            save({ width: 1000, height: 700, x: 2200, y: 200 });
            const twoDisplays = {
                getAllDisplays: () => [
                    ...ONE_DISPLAY.getAllDisplays(),
                    { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } },
                ],
            };
            expect(new WindowState(path, twoDisplays).bounds()).toMatchObject({
                x: 2200,
                y: 200,
            });
        });
    });

    describe('a state file that cannot be trusted', () => {
        it.each([
            ['corrupt', '{not json'],
            ['empty', ''],
            ['null', 'null'],
        ])('falls back to defaults on a %s file', (_label, contents) => {
            writeFileSync(path, contents);
            const bounds = new WindowState(path, ONE_DISPLAY).bounds();
            expect(bounds.width).toBeGreaterThanOrEqual(MIN_WIDTH);
            expect(bounds.height).toBeGreaterThanOrEqual(MIN_HEIGHT);
        });
    });

    describe('tracking a window', () => {
        function fakeWindow() {
            const handlers = new Map();
            return {
                handlers,
                on: (event, fn) => handlers.set(event, fn),
                once: () => {},
                isDestroyed: () => false,
                isMaximized: () => false,
                getBounds: () => ({ x: 50, y: 60, width: 1100, height: 750 }),
                getNormalBounds: () => ({ x: 50, y: 60, width: 1100, height: 750 }),
            };
        }

        it('writes immediately on close, with no chance of a later save', () => {
            const state = new WindowState(path, ONE_DISPLAY);
            const win = fakeWindow();
            state.track(win);

            win.handlers.get('close')();

            expect(existsSync(path)).toBe(true);
            expect(JSON.parse(readFileSync(path, 'utf-8'))).toMatchObject({
                width: 1100,
                height: 750,
                x: 50,
                y: 60,
            });
        });

        it('stores the restored size while maximized, not the screen size', () => {
            const state = new WindowState(path, ONE_DISPLAY);
            const win = {
                ...fakeWindow(),
                isMaximized: () => true,
                getBounds: () => ({ x: 0, y: 0, width: 1920, height: 1055 }),
                getNormalBounds: () => ({ x: 50, y: 60, width: 1100, height: 750 }),
            };
            const handlers = new Map();
            win.on = (event, fn) => handlers.set(event, fn);
            state.track(win);

            handlers.get('close')();

            const saved = JSON.parse(readFileSync(path, 'utf-8'));
            // Otherwise un-maximizing leaves a window the size of the display.
            expect(saved.width).toBe(1100);
            expect(saved.maximized).toBe(true);
        });
    });
});
