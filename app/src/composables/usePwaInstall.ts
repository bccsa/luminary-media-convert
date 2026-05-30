import { onMounted, onUnmounted, ref } from 'vue';

const DISMISS_STORAGE_KEY = 'luminary-pwa-install-dismissed';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const GESTURE_EVENTS = ['pointerdown', 'keydown', 'touchstart'] as const;

function isStandaloneDisplay(): boolean {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        // Safari iOS
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
}

function isDismissed(): boolean {
    try {
        return localStorage.getItem(DISMISS_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function isIosDevice(): boolean {
    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
}

/**
 * PWA install flow.
 *
 * The browser's native install modal cannot be shown without a user gesture
 * (per spec, `BeforeInstallPromptEvent.prompt()` requires transient
 * activation). To make it feel automatic "on open", we capture the deferred
 * event and fire the native modal on the user's first interaction with the
 * page. A custom card is shown only as a fallback (e.g. if firing the native
 * modal throws) and to give iOS users Add to Home Screen instructions.
 */
export function usePwaInstall() {
    const visible = ref(false);
    const iosHint = ref(false);
    const installing = ref(false);
    const canInstall = ref(false);

    let deferredPrompt: BeforeInstallPromptEvent | null = null;
    let autoPromptArmed = false;

    function setDeferred(event: BeforeInstallPromptEvent | null) {
        deferredPrompt = event;
        canInstall.value = event !== null;
    }

    function disarmAutoPrompt() {
        if (!autoPromptArmed) return;
        autoPromptArmed = false;
        for (const evt of GESTURE_EVENTS) {
            window.removeEventListener(evt, onFirstGesture, true);
        }
    }

    function onFirstGesture() {
        disarmAutoPrompt();
        // Fire the native modal inside the gesture to keep transient activation.
        void install();
    }

    function armAutoPrompt() {
        if (autoPromptArmed || !deferredPrompt) return;
        autoPromptArmed = true;
        for (const evt of GESTURE_EVENTS) {
            window.addEventListener(evt, onFirstGesture, { capture: true, once: true });
        }
    }

    function onBeforeInstallPrompt(event: Event) {
        // Prevent the browser's default mini-infobar so we control when the
        // native modal appears (on first user gesture, see armAutoPrompt).
        event.preventDefault();
        setDeferred(event as BeforeInstallPromptEvent);
        armAutoPrompt();
    }

    function onAppInstalled() {
        setDeferred(null);
        disarmAutoPrompt();
        visible.value = false;
    }

    onMounted(() => {
        if (isStandaloneDisplay() || isDismissed()) return;

        window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        window.addEventListener('appinstalled', onAppInstalled);

        // iOS has no beforeinstallprompt / native modal — surface the manual
        // Add to Home Screen instructions instead.
        if (isIosDevice()) {
            iosHint.value = true;
            visible.value = true;
        }
    });

    onUnmounted(() => {
        window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
        window.removeEventListener('appinstalled', onAppInstalled);
        disarmAutoPrompt();
    });

    function dismiss() {
        try {
            localStorage.setItem(DISMISS_STORAGE_KEY, '1');
        } catch {
            /* ignore */
        }
        disarmAutoPrompt();
        visible.value = false;
    }

    async function install() {
        if (!deferredPrompt || installing.value) return;
        installing.value = true;
        const promptEvent = deferredPrompt;
        // A beforeinstallprompt event can only be prompted once.
        setDeferred(null);
        try {
            await promptEvent.prompt();
            const { outcome } = await promptEvent.userChoice;
            // accepted -> installed; dismissed -> respect the choice this
            // session (the browser won't re-offer the same event).
            visible.value = false;
            if (outcome === 'dismissed') iosHint.value = false;
        } catch {
            // prompt() can throw if called without activation; restore the
            // event and show the fallback card with a manual Install button.
            setDeferred(promptEvent);
            iosHint.value = false;
            visible.value = true;
        } finally {
            installing.value = false;
        }
    }

    return { visible, iosHint, installing, canInstall, dismiss, install };
}
