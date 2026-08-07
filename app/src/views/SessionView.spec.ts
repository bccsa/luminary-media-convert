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

vi.mock('vue-router', () => ({
    useRoute: () => ({ params: { id: 'sess-1' } }),
    useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

vi.mock('../api', () => ({
    API_BASE: '',
    getSession: detail,
    getSessionStatus: status,
    listSessions: vi
        .fn()
        .mockResolvedValue([{ sessionId: 'sess-1', sessionToken: 'sess_token' }]),
    ingestLocalFile: vi.fn().mockResolvedValue({}),
    startEncode: vi.fn().mockResolvedValue({}),
    deleteSession: vi.fn().mockResolvedValue({}),
    subscribeSessionEvents: vi.fn(),
    getChapters: vi.fn().mockResolvedValue(null),
    putChapters: vi.fn().mockResolvedValue(undefined),
}));

import SessionView from './SessionView.vue';

/** A probed session sitting in the pre-encode state, which is where trimming happens. */
function uploadedSession(overrides: Record<string, unknown> = {}) {
    return {
        sessionId: 'sess-1',
        status: 'uploaded',
        title: 'test',
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

        expect(detail).toHaveBeenCalledWith('sess-1');
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
        function completedWith(hlsUrl: string | undefined) {
            detail.mockResolvedValue(
                uploadedSession({
                    status: 'completed',
                    masterPlaylist: 'out/master.m3u8',
                    hlsUrl,
                })
            );
            status.mockResolvedValue({ status: 'completed', hlsUrl });
        }

        const banner = (w: Awaited<ReturnType<typeof mountView>>) =>
            w.find('[data-testid="delivery-problem"]');

        afterEach(() => {
            // The protocol stub would otherwise leak into later tests; fetch is
            // re-stubbed by beforeEach.
            vi.unstubAllGlobals();
        });

        it('warns when the storage config has no Public URL', async () => {
            // Opened without a public base URL, so nothing can say where the
            // finished files are.
            completedWith(undefined);

            const wrapper = await mountView();

            expect(banner(wrapper).exists()).toBe(true);
            expect(banner(wrapper).text()).toContain('no public playback URL');
        });

        it('names mixed content as the cause when the page is secure', async () => {
            // jsdom serves the test page over http, where the browser permits an
            // http subresource — the block only exists on a secure page.
            vi.stubGlobal('location', {
                ...window.location,
                protocol: 'https:',
            });
            // Certain to fail: the browser refuses before the request is sent.
            completedWith('http://10.0.0.1:9000/medias/master.m3u8');

            const wrapper = await mountView();

            expect(banner(wrapper).text()).toContain('secure page');
        });

        it('stays quiet when a usable Public URL is set', async () => {
            completedWith('https://pub-abc.r2.dev/master.m3u8');

            const wrapper = await mountView();

            expect(banner(wrapper).exists()).toBe(false);
        });

        it('says nothing before there is any output to deliver', async () => {
            // Pre-encode playback comes from the encoder, not from storage.
            const wrapper = await mountView();

            expect(banner(wrapper).exists()).toBe(false);
        });
    });

    /**
     * The encoder samples its storyboard from the source, so cues are in source
     * time; a trimmed timeline runs on the programme. Left unmapped, frames sit
     * under the wrong part of the ruler and cut material stays on the strip,
     * which reads as the encode ignoring the trim — it was queried twice on
     * exactly that basis.
     */
    /**
     * The sidecar conventions are all relative to the folder the master sits in,
     * while everything the API records is a full object key from the bucket
     * root. Mixing the two dropped the session folder out of the chapters URL,
     * and because the player treats a missing sidecar as nothing worth
     * reporting, saved chapters silently never appeared.
     */
    describe('sidecar URLs on a completed session', () => {
        const MASTER_KEY = 'sess-1/master.m3u8';
        const HLS_URL = `http://127.0.0.1:9000/media/${MASTER_KEY}`;

        function playerSource(wrapper: Awaited<ReturnType<typeof mountView>>) {
            const strip = wrapper.findComponent({ name: 'SessionPlayerStrip' });
            return strip.exists()
                ? (strip.props('source') as { sidecars?: { chapters?: { url: string }[] } } | null)
                : null;
        }

        async function completedView() {
            detail.mockResolvedValue(
                uploadedSession({
                    status: 'completed',
                    masterPlaylist: MASTER_KEY,
                    thumbnailsVtt: 'sess-1/thumbnails/thumbnails.vtt',
                    hlsUrl: HLS_URL,
                })
            );
            status.mockResolvedValue({
                status: 'completed',
                masterPlaylist: MASTER_KEY,
                thumbnailsVtt: 'sess-1/thumbnails/thumbnails.vtt',
                hlsUrl: HLS_URL,
            });
            const wrapper = await mountView();
            await flushPromises();
            return wrapper;
        }

        it('points the chapters sidecar beside the master, not at the bucket root', async () => {
            const source = playerSource(await completedView());
            const url = source?.sidecars?.chapters?.[0]?.url;

            expect(url).toBe('http://127.0.0.1:9000/media/sess-1/chapters/en.vtt');
            // The bug: the session folder missing, so every session 404s.
            expect(url).not.toBe('http://127.0.0.1:9000/media/chapters/en.vtt');
        });

        it('keeps the session folder even when the prefix is nested', async () => {
            const master = 'shows/ep12/sess-1/master.m3u8';
            const hlsUrl = `https://cdn.example.com/media/${master}`;
            detail.mockResolvedValue(
                uploadedSession({
                    status: 'completed',
                    masterPlaylist: master,
                    hlsUrl,
                })
            );
            status.mockResolvedValue({
                status: 'completed',
                masterPlaylist: master,
                hlsUrl,
            });

            const wrapper = await mountView();
            await flushPromises();

            expect(playerSource(wrapper)?.sidecars?.chapters?.[0]?.url).toBe(
                'https://cdn.example.com/media/shows/ep12/sess-1/chapters/en.vtt'
            );
        });
    });

    describe('storyboard on a trimmed timeline', () => {
        const TRIMS = [{ inSec: 10, outSec: 20 }];

        function createObjectUrlSpy() {
            const spy = vi.fn(() => 'blob:retimed');
            // jsdom implements neither of these.
            vi.stubGlobal('URL', {
                ...URL,
                createObjectURL: spy,
                revokeObjectURL: vi.fn(),
            });
            return spy;
        }

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('re-times the encoder storyboard while trims are applied', async () => {
            const spy = createObjectUrlSpy();
            detail.mockResolvedValue(uploadedSession({ status: 'encoding' }));
            status.mockResolvedValue({
                status: 'encoding',
                trimSegments: TRIMS,
            });

            await mountView();
            await flushPromises();

            expect(spy).toHaveBeenCalled();
        });

        it('passes the storyboard through when nothing is trimmed', async () => {
            // No ranges means the timeline is already in source time — nothing
            // to correct, and no reason to spend a fetch and a blob on it.
            const spy = createObjectUrlSpy();
            detail.mockResolvedValue(uploadedSession({ status: 'encoding' }));
            status.mockResolvedValue({ status: 'encoding' });

            await mountView();
            await flushPromises();

            expect(spy).not.toHaveBeenCalled();
        });

        it('leaves the completed storyboard alone', async () => {
            // That one is sampled from the encoded output, so it already matches
            // the trimmed timeline; re-timing would shift correct frames.
            const spy = createObjectUrlSpy();
            detail.mockResolvedValue(
                uploadedSession({
                    status: 'completed',
                    thumbnailsVtt: 'out/thumbnails/thumbnails.vtt',
                    s3Config: {
                        endPoint: 'https://acct.r2.cloudflarestorage.com',
                        bucket: 'medias',
                        publicUrl: 'https://pub-abc.r2.dev',
                    },
                })
            );
            status.mockResolvedValue({
                status: 'completed',
                trimSegments: TRIMS,
            });

            await mountView();
            await flushPromises();

            expect(spy).not.toHaveBeenCalled();
        });
    });

    /**
     * Failures are usually transient — a full disk, a stalled upload, a restart
     * — and none of them touch the uploaded source. Without a way back, the only
     * remedy was deleting the session and uploading the file again, which on a
     * 7 GB broadcast is ten minutes and the very upload that tends to cause the
     * problem in the first place.
     */
    describe('retrying a failed encode', () => {
        function failedSession(canRetry: boolean | undefined) {
            detail.mockResolvedValue(uploadedSession({ status: 'failed' }));
            status.mockResolvedValue({
                status: 'failed',
                error: 'Not enough disk space on the encoder',
                canRetry,
                probeResult: uploadedSession().probeResult,
            });
        }

        /**
         * Whether the view is offering the encode again. Asserted on the root
         * rather than the panel itself: the panel lives inside a tab that is not
         * the default one, and the change under test is the gate, not the layout.
         */
        const canStart = (w: Awaited<ReturnType<typeof mountView>>) =>
            w.attributes('data-retry-available') === 'true';

        it('offers the encode form again when the source survived', async () => {
            failedSession(true);

            const wrapper = await mountView();
            await flushPromises();

            expect(canStart(wrapper)).toBe(true);
        });

        it('does not offer it when the source is gone', async () => {
            // Nothing to retry from — this one genuinely needs re-uploading.
            failedSession(false);

            const wrapper = await mountView();
            await flushPromises();

            expect(canStart(wrapper)).toBe(false);
        });

        it('does not offer it when the encoder said nothing either way', async () => {
            // An older encoder, or a session it no longer holds. Absence of the
            // flag is not permission.
            failedSession(undefined);

            const wrapper = await mountView();
            await flushPromises();

            expect(canStart(wrapper)).toBe(false);
        });

        it('asks the encoder about a failed session at all', async () => {
            // The status only reaches the client if something requests it, and
            // a failed session previously triggered no request.
            failedSession(true);

            await mountView();
            await flushPromises();

            expect(status).toHaveBeenCalled();
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
