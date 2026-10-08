import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useFullscreenOrientation } from '../src/composables/useFullscreenOrientation';

interface OrientationStub {
    type: string;
    lock: ReturnType<typeof vi.fn>;
    unlock: ReturnType<typeof vi.fn>;
    addEventListener: (type: string, listener: () => void) => void;
    removeEventListener: (type: string, listener: () => void) => void;
    emitChange: () => void;
    listeners: Set<() => void>;
}

let orientation: OrientationStub;

function stubOrientation(): OrientationStub {
    const listeners = new Set<() => void>();
    const stub: OrientationStub = {
        type: 'portrait-primary',
        lock: vi.fn(async () => {}),
        unlock: vi.fn(),
        listeners,
        addEventListener: (_type, listener) => listeners.add(listener),
        removeEventListener: (_type, listener) => listeners.delete(listener),
        emitChange: () => {
            for (const listener of [...listeners]) listener();
        },
    };
    Object.defineProperty(window.screen, 'orientation', { value: stub, configurable: true });
    return stub;
}

function setFullscreenElement(el: Element | null): void {
    Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true });
    document.dispatchEvent(new Event('fullscreenchange'));
}

function createElements(options: { elementFullscreen: boolean }) {
    const container = document.createElement('div');
    const video = document.createElement('video') as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void;
        webkitExitFullscreen?: () => void;
    };
    document.body.append(container);
    container.append(video);

    video.webkitEnterFullscreen = vi.fn();
    video.webkitExitFullscreen = vi.fn();

    if (options.elementFullscreen) {
        container.requestFullscreen = vi.fn(async () => {
            setFullscreenElement(container);
        });
    } else {
        // iPhone Safari: no Element.requestFullscreen at all.
        Object.defineProperty(container, 'requestFullscreen', {
            value: undefined,
            configurable: true,
        });
    }
    return { container, video };
}

beforeEach(() => {
    document.body.innerHTML = '';
    orientation = stubOrientation();
    Object.defineProperty(document, 'fullscreenElement', { value: null, configurable: true });
    document.exitFullscreen = vi.fn(async () => {
        setFullscreenElement(null);
    });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useFullscreenOrientation — element fullscreen', () => {
    it('requests fullscreen on the container and locks landscape', async () => {
        const { container, video } = createElements({ elementFullscreen: true });
        const fs = useFullscreenOrientation();

        const mode = await fs.enter(container, video);

        expect(mode).toBe('element');
        expect(fs.mode.value).toBe('element');
        expect(fs.isFullscreen.value).toBe(true);
        expect(container.requestFullscreen).toHaveBeenCalled();
        expect(orientation.lock).toHaveBeenCalledWith('landscape');
        expect(video.webkitEnterFullscreen).not.toHaveBeenCalled();
    });

    it('survives an orientation lock rejection', async () => {
        const { container, video } = createElements({ elementFullscreen: true });
        orientation.lock.mockRejectedValueOnce(new Error('not supported'));
        const fs = useFullscreenOrientation();

        await expect(fs.enter(container, video)).resolves.toBe('element');
        expect(fs.isFullscreen.value).toBe(true);
    });

    it('exits fullscreen when the device is rotated back to portrait', async () => {
        const { container, video } = createElements({ elementFullscreen: true });
        const fs = useFullscreenOrientation();
        await fs.enter(container, video);

        orientation.type = 'landscape-primary';
        orientation.emitChange();
        expect(document.exitFullscreen).not.toHaveBeenCalled();

        orientation.type = 'portrait-primary';
        orientation.emitChange();
        expect(document.exitFullscreen).toHaveBeenCalledTimes(1);
    });

    it('unlocks the orientation and drops listeners on exit', async () => {
        const { container, video } = createElements({ elementFullscreen: true });
        const fs = useFullscreenOrientation();
        await fs.enter(container, video);

        await fs.exit();

        expect(document.exitFullscreen).toHaveBeenCalled();
        expect(fs.isFullscreen.value).toBe(false);
        expect(fs.mode.value).toBeNull();
        expect(orientation.unlock).toHaveBeenCalled();
        expect(orientation.listeners.size).toBe(0);
    });

    it('tracks fullscreen exits triggered outside the composable', async () => {
        const { container, video } = createElements({ elementFullscreen: true });
        const fs = useFullscreenOrientation();
        await fs.enter(container, video);

        setFullscreenElement(null);

        expect(fs.isFullscreen.value).toBe(false);
        expect(orientation.unlock).toHaveBeenCalled();
    });
});

describe('useFullscreenOrientation — iPhone native fullscreen', () => {
    it('uses webkitEnterFullscreen and reports native mode', async () => {
        const { container, video } = createElements({ elementFullscreen: false });
        const fs = useFullscreenOrientation();

        const mode = await fs.enter(container, video);

        expect(mode).toBe('native');
        expect(fs.mode.value).toBe('native');
        expect(fs.isFullscreen.value).toBe(true);
        expect(video.webkitEnterFullscreen).toHaveBeenCalled();
        expect(orientation.lock).not.toHaveBeenCalled();
    });

    it('exits through webkitExitFullscreen', async () => {
        const { container, video } = createElements({ elementFullscreen: false });
        const fs = useFullscreenOrientation();
        await fs.enter(container, video);

        await fs.exit();

        expect(video.webkitExitFullscreen).toHaveBeenCalled();
        expect(document.exitFullscreen).not.toHaveBeenCalled();
        expect(fs.isFullscreen.value).toBe(false);
    });

    it('reacts to the platform ending fullscreen itself', async () => {
        const { container, video } = createElements({ elementFullscreen: false });
        const fs = useFullscreenOrientation();
        await fs.enter(container, video);

        video.dispatchEvent(new Event('webkitendfullscreen'));

        expect(fs.isFullscreen.value).toBe(false);
        expect(fs.mode.value).toBeNull();
    });
});

describe('useFullscreenOrientation — teardown', () => {
    it('cleans up when the surrounding effect scope is disposed', async () => {
        const { container, video } = createElements({ elementFullscreen: true });
        const scope = effectScope();
        const fs = await scope.run(async () => {
            const instance = useFullscreenOrientation();
            await instance.enter(container, video);
            return instance;
        })!;

        scope.stop();

        expect(orientation.listeners.size).toBe(0);
        expect(orientation.unlock).toHaveBeenCalled();
        expect(fs.mode.value).toBeNull();
    });
});
