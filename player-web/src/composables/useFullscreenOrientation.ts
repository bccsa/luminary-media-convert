import { onScopeDispose, ref } from 'vue';
import type { Ref } from 'vue';

/**
 * How fullscreen was entered.
 *
 * - `element`: the player container is the fullscreen element, so the package
 *   renders its own controls over it (Android, desktop, iPad).
 * - `native`: the platform took over with its own player UI
 *   (`webkitEnterFullscreen`, i.e. iPhone) — never render custom controls.
 */
export type FullscreenMode = 'element' | 'native' | null;

interface WebkitVideoElement extends HTMLVideoElement {
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
}

/** `screen.orientation` is absent on Safari/iOS; every use is optional. */
interface OrientationApi {
    type?: string;
    lock?: (orientation: string) => Promise<void>;
    unlock?: () => void;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
}

function getOrientation(): OrientationApi | undefined {
    if (typeof screen === 'undefined') return undefined;
    return (screen as Screen & { orientation?: OrientationApi }).orientation;
}

/**
 * True when the container can be made the fullscreen element.
 *
 * iPhone Safari exposes no `Element.requestFullscreen` — only the video
 * element's `webkitEnterFullscreen`. Detected by feature, never by user agent.
 */
function canFullscreenElement(container: HTMLElement): boolean {
    return (
        typeof container.requestFullscreen === 'function' &&
        typeof document !== 'undefined' &&
        typeof document.exitFullscreen === 'function'
    );
}

export interface UseFullscreenOrientation {
    isFullscreen: Ref<boolean>;
    mode: Ref<FullscreenMode>;
    enter: (container: HTMLElement, video: HTMLVideoElement) => Promise<FullscreenMode>;
    exit: () => Promise<void>;
}

/**
 * Fullscreen entry plus the landscape-orientation dance that goes with it.
 *
 * Everything orientation-related is a guarded no-op where unsupported
 * (`screen.orientation.lock` is reliable on Chromium/Android only).
 */
export function useFullscreenOrientation(): UseFullscreenOrientation {
    const isFullscreen = ref(false);
    const mode = ref<FullscreenMode>(null);

    let videoEl: WebkitVideoElement | null = null;
    let listening = false;

    const onFullscreenChange = (): void => {
        const active = typeof document !== 'undefined' && document.fullscreenElement != null;
        isFullscreen.value = active;
        if (!active) cleanup();
    };

    const onNativeEnd = (): void => {
        isFullscreen.value = false;
        cleanup();
    };

    const onOrientationChange = (): void => {
        if (!isFullscreen.value || mode.value !== 'element') return;
        const type = getOrientation()?.type ?? '';
        // Rotating back to portrait means "give me the page again".
        if (type.startsWith('portrait')) void document.exitFullscreen?.();
    };

    function listen(video: WebkitVideoElement): void {
        if (listening) return;
        listening = true;
        document.addEventListener('fullscreenchange', onFullscreenChange);
        video.addEventListener('webkitendfullscreen', onNativeEnd);
        getOrientation()?.addEventListener?.('change', onOrientationChange);
    }

    function cleanup(): void {
        if (listening) {
            document.removeEventListener('fullscreenchange', onFullscreenChange);
            videoEl?.removeEventListener('webkitendfullscreen', onNativeEnd);
            getOrientation()?.removeEventListener?.('change', onOrientationChange);
            listening = false;
        }
        try {
            getOrientation()?.unlock?.();
        } catch {
            /* unlock is unsupported or not permitted here */
        }
        mode.value = null;
        videoEl = null;
    }

    async function enter(container: HTMLElement, video: HTMLVideoElement): Promise<FullscreenMode> {
        videoEl = video as WebkitVideoElement;
        listen(videoEl);

        if (!canFullscreenElement(container)) {
            videoEl.webkitEnterFullscreen?.();
            mode.value = 'native';
            isFullscreen.value = true;
            return 'native';
        }

        await container.requestFullscreen();
        mode.value = 'element';
        isFullscreen.value = true;
        try {
            await getOrientation()?.lock?.('landscape');
        } catch {
            /* orientation lock is unsupported or rejected — cosmetic only */
        }
        return 'element';
    }

    async function exit(): Promise<void> {
        if (mode.value === 'native') {
            videoEl?.webkitExitFullscreen?.();
            isFullscreen.value = false;
            cleanup();
            return;
        }
        if (typeof document !== 'undefined' && document.fullscreenElement) {
            await document.exitFullscreen();
            // `fullscreenchange` finishes the teardown.
            return;
        }
        isFullscreen.value = false;
        cleanup();
    }

    onScopeDispose(() => {
        cleanup();
    }, true);

    return { isFullscreen, mode, enter, exit };
}
