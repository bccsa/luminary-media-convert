// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

    it('keeps the encoder storyboard while the encode is running', async () => {
        // The encode's own storyboard reaches S3 only at completion. Gated on
        // the pre-encode state, the timeline dropped all its frames the moment
        // Start Encoding was pressed and stayed bare for the whole encode.
        detail.mockResolvedValue(uploadedSession({ status: 'encoding' }));
        status.mockResolvedValue({ status: 'encoding' });

        await mountView();

        const asked = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls
            .map((c) => String(c[0]))
            .some((u) => u.includes('thumbnails.vtt'));
        expect(asked).toBe(true);
    });

    /**
     * A storage config with no usable delivery URL still encodes perfectly — the
     * objects land in the bucket and only the address handed to the browser
     * cannot work. Unsaid, that presents as a player spinning forever with the
     * reason visible only in the console.
     */
    describe('undeliverable storage', () => {
        function completedWith(s3Config: Record<string, unknown>) {
            detail.mockResolvedValue(
                uploadedSession({
                    status: 'completed',
                    masterPlaylist: 'out/master.m3u8',
                    s3Config,
                })
            );
            status.mockResolvedValue({ status: 'completed' });
        }

        const banner = (w: Awaited<ReturnType<typeof mountView>>) =>
            w.find('[data-testid="delivery-problem"]');

        afterEach(() => {
            // The protocol stub would otherwise leak into later tests; fetch is
            // re-stubbed by beforeEach.
            vi.unstubAllGlobals();
        });

        it('warns when the storage config has no Public URL', async () => {
            completedWith({
                endPoint: 'https://acct.r2.cloudflarestorage.com',
                bucket: 'medias',
            });

            const wrapper = await mountView();

            expect(banner(wrapper).exists()).toBe(true);
            expect(banner(wrapper).text()).toContain('no Public URL');
        });

        it('names mixed content as the cause when the page is secure', async () => {
            // jsdom serves the test page over http, where the browser permits an
            // http subresource — the block only exists on a secure page.
            vi.stubGlobal('location', {
                ...window.location,
                protocol: 'https:',
            });
            // Certain to fail: the browser refuses before the request is sent.
            completedWith({
                endPoint: 'https://acct.r2.cloudflarestorage.com',
                bucket: 'medias',
                publicUrl: 'http://10.0.0.1:9000/medias',
            });

            const wrapper = await mountView();

            expect(banner(wrapper).text()).toContain('secure page');
        });

        it('stays quiet when a usable Public URL is set', async () => {
            completedWith({
                endPoint: 'https://acct.r2.cloudflarestorage.com',
                bucket: 'medias',
                publicUrl: 'https://pub-abc.r2.dev',
            });

            const wrapper = await mountView();

            expect(banner(wrapper).exists()).toBe(false);
        });

        it('says nothing before there is any output to deliver', async () => {
            // Pre-encode playback comes from the encoder, not from storage.
            const wrapper = await mountView();

            expect(banner(wrapper).exists()).toBe(false);
        });
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
