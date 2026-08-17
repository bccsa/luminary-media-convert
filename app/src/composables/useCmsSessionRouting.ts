import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';

/**
 * Follow the CMS to the session it just opened.
 *
 * The host brings the window forward when a CMS creates a session, but forward
 * onto whatever the user was last looking at. Opening a session for a different
 * post therefore showed them the wrong one and left them to find the new one in
 * the list — with nothing on screen saying a new one had arrived.
 *
 * Two arrivals to cover, because they differ in whether this renderer exists
 * yet:
 *
 * - The window is already up: the host pushes the id and we navigate.
 * - The click that created the session also launched the app: there was no
 *   renderer to push to, so the host parked the id and we claim it on mount.
 *
 * The claim is one-shot on the host side, which is what stops a later reload
 * from yanking the user back to a session they have since moved on from.
 */
export function useCmsSessionRouting(): void {
    const router = useRouter();
    let unsubscribe: (() => void) | undefined;

    function show(sessionId: string): void {
        if (!sessionId) return;
        // `replace` rather than `push`: arriving here is not a step the user
        // took, so Back should not lead to the session they were pulled away
        // from — it should lead where they were before all this.
        void router.replace(`/sessions/${sessionId}`);
    }

    onMounted(async () => {
        const bridge = window.luminary;
        if (!bridge) return;

        unsubscribe = bridge.onShowSession(show);

        const pending = await bridge.takePendingSession();
        if (pending) show(pending);
    });

    onUnmounted(() => unsubscribe?.());
}
