/**
 * Give tests a working `localStorage`.
 *
 * Node 22+ defines its own experimental storage globals. They resolve to
 * `undefined` unless the process was started with `--localstorage-file`, and
 * because they sit on `globalThis` — which is also `window` under Vitest's jsdom
 * environment — they shadow the implementation jsdom installs. Any bare
 * `localStorage` reference, in a spec or in `layoutStorage` under test, then hits
 * Node's empty global and fails with "Cannot read properties of undefined".
 *
 * The same shim lives in `app/vitest.setup.ts`, which carries the longer version
 * of this note. It is copied rather than shared because this is a published
 * library and the app is not one of its dependencies — the direction of that
 * import would be backwards.
 */
class MemoryStorage {
    #entries = new Map<string, string>();

    get length(): number {
        return this.#entries.size;
    }

    key(index: number): string | null {
        return [...this.#entries.keys()][index] ?? null;
    }

    getItem(key: string): string | null {
        return this.#entries.get(String(key)) ?? null;
    }

    setItem(key: string, value: string): void {
        this.#entries.set(String(key), String(value));
    }

    removeItem(key: string): void {
        this.#entries.delete(String(key));
    }

    clear(): void {
        this.#entries.clear();
    }
}

function usable(name: string): boolean {
    try {
        return typeof (globalThis as any)[name]?.getItem === 'function';
    } catch {
        return false;
    }
}

function define(name: string, value: unknown): void {
    Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
    });
}

// Only step in when the platform has not provided usable storage of its own.
if (!usable('localStorage') || !usable('sessionStorage')) {
    define('Storage', MemoryStorage);
    define('localStorage', new MemoryStorage());
    define('sessionStorage', new MemoryStorage());
}
