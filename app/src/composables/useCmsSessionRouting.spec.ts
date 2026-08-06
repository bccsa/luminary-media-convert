import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount, flushPromises } from '@vue/test-utils';

const replace = vi.fn();
vi.mock('vue-router', () => ({
    useRouter: () => ({ replace, push: vi.fn() }),
}));

import { useCmsSessionRouting } from './useCmsSessionRouting';

const Host = defineComponent({
    setup() {
        useCmsSessionRouting();
        return () => h('div');
    },
});

let onShowSession: ReturnType<typeof vi.fn>;
let takePendingSession: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
/** The handler the composable registered, so a host push can be simulated. */
let pushToRenderer: ((sessionId: string) => void) | undefined;

function installBridge(pending: string | null = null) {
    unsubscribe = vi.fn();
    pushToRenderer = undefined;
    onShowSession = vi.fn((handler: (id: string) => void) => {
        pushToRenderer = handler;
        return unsubscribe;
    });
    takePendingSession = vi.fn().mockResolvedValue(pending);
    (window as unknown as { luminary?: unknown }).luminary = {
        getApiToken: vi.fn(),
        getPathForFile: vi.fn(),
        showOpenDialog: vi.fn(),
        onShowSession,
        takePendingSession,
    };
}

beforeEach(() => {
    replace.mockReset();
});

afterEach(() => {
    delete (window as unknown as { luminary?: unknown }).luminary;
});

describe('useCmsSessionRouting', () => {
    it('navigates when the host pushes a session', async () => {
        installBridge();
        mount(Host);
        await flushPromises();

        pushToRenderer!('sess-42');

        expect(replace).toHaveBeenCalledWith('/sessions/sess-42');
    });

    it('claims a session opened before this renderer existed', async () => {
        // The click that created it launched the app, so there was no renderer
        // to push to and the host parked the id.
        installBridge('sess-launch');
        mount(Host);
        await flushPromises();

        expect(replace).toHaveBeenCalledWith('/sessions/sess-launch');
    });

    it('stays put when nothing was parked', async () => {
        installBridge(null);
        mount(Host);
        await flushPromises();

        expect(replace).not.toHaveBeenCalled();
    });

    it('replaces rather than pushes', async () => {
        // Arriving here is not a step the user took, so Back should not lead to
        // the session they were pulled away from.
        installBridge('sess-1');
        mount(Host);
        await flushPromises();

        expect(replace).toHaveBeenCalledTimes(1);
    });

    it('ignores an empty id', async () => {
        installBridge();
        mount(Host);
        await flushPromises();

        pushToRenderer!('');

        expect(replace).not.toHaveBeenCalled();
    });

    it('stops listening when the shell goes away', async () => {
        installBridge();
        const wrapper = mount(Host);
        await flushPromises();

        wrapper.unmount();
        await nextTick();

        expect(unsubscribe).toHaveBeenCalled();
    });

    it('does nothing at all in a plain browser', async () => {
        // Browser development has no preload bridge; the composable must not
        // assume one is there.
        delete (window as unknown as { luminary?: unknown }).luminary;

        expect(() => mount(Host)).not.toThrow();
        await flushPromises();
        expect(replace).not.toHaveBeenCalled();
    });
});
