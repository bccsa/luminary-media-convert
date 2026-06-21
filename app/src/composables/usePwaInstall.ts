import { onMounted, onUnmounted, ref } from 'vue';

interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandaloneDisplay(): boolean {
    return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.matchMedia('(display-mode: fullscreen)').matches ||
        // Safari iOS
        (navigator as Navigator & { standalone?: boolean }).standalone === true
    );
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
 * activation). We capture the deferred event and surface a custom install
 * card; the native modal is fired only when the user clicks the card's
 * Install button. iOS has no native modal, so the card shows Add to Home
 * Screen instructions instead. Installing must remain a deliberate user
 * choice — we never auto-fire the prompt on incidental page interactions.
 */
export function usePwaInstall() {
    const visible = ref(false);
    const iosHint = ref(false);
    const installing = ref(false);
    const canInstall = ref(false);

    let deferredPrompt: BeforeInstallPromptEvent | null = null;

    function setDeferred(event: BeforeInstallPromptEvent | null) {
        deferredPrompt = event;
        canInstall.value = event !== null;
    }

    function onBeforeInstallPrompt(event: Event) {
        // Prevent the browser's default mini-infobar so we control when the
        // native modal appears (only from the card's Install button).
        event.preventDefault();
        setDeferred(event as BeforeInstallPromptEvent);
        // Surface the install card; the user decides whether to install.
        visible.value = true;
    }

    function onAppInstalled() {
        setDeferred(null);
        visible.value = false;
    }

    onMounted(() => {
        if (isStandaloneDisplay()) return;

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
    });

    function dismiss() {
        // Hide for the current session only — the card resurfaces on the next
        // visit so installing stays available (the choice isn't persisted).
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
