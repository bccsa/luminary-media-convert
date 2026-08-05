/**
 * Remembers where the window was and how big.
 *
 * Restoring position is the part that needs care. A saved position is only
 * valid while the display it referred to still exists — unplug the external
 * monitor the app was last used on and the naive version reopens the window at
 * coordinates nothing can reach, which looks exactly like the app failing to
 * start. So bounds are only reused when they still intersect a display, and
 * otherwise fall back to the default size, centred.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Comfortable for the session view: player, timeline and chapter list. */
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 820;

/**
 * Below this the encode form and the timeline start overlapping rather than
 * reflowing, so the window refuses to go smaller.
 */
export const MIN_WIDTH = 940;
export const MIN_HEIGHT = 640;

const SAVE_DEBOUNCE_MS = 400;

export class WindowState {
    #path;
    #screen;
    #state;
    #timer = null;

    /**
     * @param {string} filePath JSON file under userData
     * @param {import('electron').Screen} screen
     */
    constructor(filePath, screen) {
        this.#path = filePath;
        this.#screen = screen;
        this.#state = this.#load();
    }

    #load() {
        const fallback = {
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            maximized: false,
        };
        if (!existsSync(this.#path)) return fallback;

        try {
            const saved = JSON.parse(readFileSync(this.#path, 'utf-8'));
            return {
                width: Math.max(MIN_WIDTH, saved.width ?? DEFAULT_WIDTH),
                height: Math.max(MIN_HEIGHT, saved.height ?? DEFAULT_HEIGHT),
                x: saved.x,
                y: saved.y,
                maximized: Boolean(saved.maximized),
            };
        } catch {
            return fallback;
        }
    }

    /** Whether a saved position still lands on a screen that exists. */
    #positionIsVisible(state) {
        if (state.x === undefined || state.y === undefined) return false;

        return this.#screen.getAllDisplays().some(({ workArea }) => {
            // Require the top-left to be inside a work area rather than merely
            // overlapping it, so the title bar is always grabbable.
            return (
                state.x >= workArea.x &&
                state.y >= workArea.y &&
                state.x < workArea.x + workArea.width &&
                state.y < workArea.y + workArea.height
            );
        });
    }

    /** Options to hand BrowserWindow. */
    bounds() {
        const { width, height } = this.#state;
        const position = this.#positionIsVisible(this.#state)
            ? { x: this.#state.x, y: this.#state.y }
            : {};

        return {
            width,
            height,
            minWidth: MIN_WIDTH,
            minHeight: MIN_HEIGHT,
            ...position,
        };
    }

    get startMaximized() {
        return this.#state.maximized;
    }

    /**
     * Track a window. Resize and move fire continuously while dragging, so
     * writes are debounced; close is written immediately, since there is no
     * later chance.
     */
    track(window) {
        const remember = () => {
            if (window.isDestroyed()) return;
            const maximized = window.isMaximized();
            // Store the restored bounds, not the maximized ones — otherwise
            // un-maximizing gives a window the size of the screen.
            const bounds = maximized
                ? window.getNormalBounds()
                : window.getBounds();
            this.#state = { ...bounds, maximized };
        };

        const schedule = () => {
            remember();
            clearTimeout(this.#timer);
            this.#timer = setTimeout(() => this.#save(), SAVE_DEBOUNCE_MS);
        };

        window.on('resize', schedule);
        window.on('move', schedule);
        window.on('maximize', schedule);
        window.on('unmaximize', schedule);
        window.on('close', () => {
            clearTimeout(this.#timer);
            remember();
            this.#save();
        });
    }

    #save() {
        try {
            mkdirSync(dirname(this.#path), { recursive: true });
            const tmp = `${this.#path}.tmp`;
            writeFileSync(tmp, JSON.stringify(this.#state, null, 2));
            renameSync(tmp, this.#path);
        } catch {
            // Losing the remembered geometry is a cosmetic problem; failing to
            // close the window over it would not be.
        }
    }
}
