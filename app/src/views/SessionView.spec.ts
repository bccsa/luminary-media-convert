// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { shallowMount, flushPromises } from '@vue/test-utils';

/**
 * A mountable SessionView.
 *
 * Every view-level regression in this app has lived in this file — a panel
 * rendered inside a hidden section, a composable read before its dependencies, a
 * config built from an unmounted child — and none of them was reachable by a
 * test, because nothing could mount it. The mocks below exist to make that
 * possible, not to prove anything themselves: they replace the network, the
 * router and Auth0, and `shallowMount` stubs the children so the assertions are
 * about this view's own wiring.
 */

const { detail, status, waveform } = vi.hoisted(() => ({
    detail: vi.fn(),
    status: vi.fn(),
    waveform: vi.fn(),
}));

vi.mock('@auth0/auth0-vue', () => ({
    useAuth0: () => ({ getAccessTokenSilently: async () => 'token' }),
}));

vi.mock('vue-router', () => ({
    useRoute: () => ({ params: { id: 'sess-1' } }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('../api', () => ({
    getSessionDetail: detail,
    getSessionStatus: status,
    startEncode: vi.fn().mockResolvedValue({}),
    deleteSession: vi.fn().mockResolvedValue({}),
    updateSessionName: vi.fn().mockResolvedValue({}),
    getSessionWaveform: waveform,
}));

import SessionView from './SessionView.vue';

/** A probed session sitting in the pre-encode state, which is where trimming happens. */
function uploadedSession(overrides: Record<string, unknown> = {}) {
    return {
        id: 'sess-1',
        status: 'uploaded',
        name: 'test',
        encodingApiUrl: 'https://api.example.com',
        sessionToken: 'sess_token',
        probeResult: {
            format: { duration: 120 },
            videoTracks: [{ width: 1920, height: 1080, frameRate: 25 }],
            audioTracks: [{ language: 'eng' }],
        },
        ...overrides,
    };
}

async function mountView() {
    const wrapper = shallowMount(SessionView, {
        global: { stubs: { Teleport: true, Transition: true } },
    });
    await flushPromises();
    return wrapper;
}

describe('SessionView', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        detail.mockResolvedValue(uploadedSession());
        // The encoder is the source of truth for probe results once uploaded;
        // without one the view stays out of the pre-encode state entirely.
        status.mockResolvedValue({
            status: 'uploaded',
            probeResult: uploadedSession().probeResult,
        });
        waveform.mockResolvedValue({ peaks: [0.1, 0.9, 0.4] });
        // Routed by URL: a single blanket shape made previewAudioTracks a
        // non-array and the resulting render error took the whole mount down,
        // which then looked like "the view never loaded the session".
        vi.stubGlobal(
            'fetch',
            vi.fn().mockImplementation((input: unknown) => {
                const url = String(input);
                const reply = (body: unknown, text = '') => ({
                    ok: true,
                    status: 200,
                    headers: { get: () => 'false' },
                    json: async () => body,
                    text: async () => text,
                });
                if (url.includes('/preview/audio-tracks')) return reply([]);
                if (url.includes('/waveform')) return reply({ peaks: [0.2, 0.6] });
                if (url.includes('thumbnails.vtt'))
                    return Promise.resolve(reply({}, 'WEBVTT\n'));
                return Promise.resolve(reply({}));
            })
        );
    });

    it('mounts without throwing', async () => {
        // The regression this pins: reading a composable above the refs it
        // depends on threw `Cannot access ... before initialization` and took the
        // whole view down, leaving a blank page rather than a broken panel.
        const wrapper = await mountView();

        expect(wrapper.exists()).toBe(true);
    });

    it('loads the session it was routed to', async () => {
        await mountView();

        expect(detail).toHaveBeenCalledWith('token', 'sess-1');
    });

    it('surfaces a load failure instead of rendering an empty shell', async () => {
        detail.mockRejectedValue(new Error('Invalid or expired session token'));

        const wrapper = await mountView();

        expect(wrapper.text()).toContain('Invalid or expired session token');
    });

    it('asks for the waveform for a session that has not been encoded yet', async () => {
        // Pre-encode the peaks come from the API's copy of the source; only after
        // an encode do they come from the sidecar in S3.
        await mountView();

        const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => String(c[0]))
            .some((u) => u.includes('/waveform'));
        expect(called).toBe(true);
    });

    it('reads the storyboard from the encoder before an encode exists', async () => {
        // After encoding it comes from S3; before, only the API has the source to
        // sample, and the token has to ride on the URL.
        await mountView();

        const storyboardUrl = (
            globalThis.fetch as ReturnType<typeof vi.fn>
        ).mock.calls
            .map((c) => String(c[0]))
            .find((u) => u.includes('thumbnails.vtt'));

        expect(storyboardUrl).toContain('/api/sessions/sess-1/thumbnails');
        expect(storyboardUrl).toContain('token=');
    });
});
