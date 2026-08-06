import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth-token', () => ({
    getApiToken: vi.fn().mockResolvedValue('instance-token'),
}));

import {
    API_BASE,
    deleteSession,
    getChapters,
    getSession,
    getSessionStatus,
    ingestLocalFile,
    listSessions,
    putChapters,
    startEncode,
    subscribeSessionEvents,
} from './api';
import type { EncodeConfig } from './types';

const fetchMock = vi.fn();

/** A fetch response with just the surface `api.ts` reads off it. */
function respond(
    body: unknown,
    { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
) {
    return {
        ok,
        status,
        json: vi.fn().mockResolvedValue(body),
    } as unknown as Response;
}

/** The (url, init) pair of the last fetch call. */
function lastCall(): [string, RequestInit] {
    return fetchMock.mock.calls.at(-1) as [string, RequestInit];
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

beforeEach(() => {
    fetchMock.mockReset().mockResolvedValue(respond({}));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('api — credentials', () => {
    it('sends the instance token on the routes only the UI may call', async () => {
        // There is no sign-in any more. The UI's credential is the instance API
        // token, taken from the preload bridge; listing sessions is master-only
        // because it is the one place session tokens are handed out.
        await listSessions();

        expect(headersOf(lastCall()[1])['X-API-Key']).toBe('instance-token');
        expect(headersOf(lastCall()[1]).Authorization).toBeUndefined();
    });

    it('sends the session token as a Bearer where one is held', async () => {
        await getSessionStatus('s1', 'sess_abc');

        expect(headersOf(lastCall()[1]).Authorization).toBe('Bearer sess_abc');
        expect(headersOf(lastCall()[1])['X-API-Key']).toBeUndefined();
    });

    it('falls back to the instance token when a session token is not in hand', async () => {
        // Deleting a session from the list happens before its token has been
        // resolved; the UI holds the superkey either way.
        await deleteSession('s1');

        expect(headersOf(lastCall()[1])['X-API-Key']).toBe('instance-token');
    });

    it('prefers the session token when both would do', async () => {
        await deleteSession('s1', 'sess_abc');

        expect(headersOf(lastCall()[1]).Authorization).toBe('Bearer sess_abc');
        expect(headersOf(lastCall()[1])['X-API-Key']).toBeUndefined();
    });

    it('sets a JSON content type only when there is a body', async () => {
        await listSessions();
        expect(headersOf(lastCall()[1])['Content-Type']).toBeUndefined();

        await startEncode('s1', { type: 'audio' } as EncodeConfig, 'sess_abc');
        expect(headersOf(lastCall()[1])['Content-Type']).toBe('application/json');
    });
});

describe('api — sessions', () => {
    it('lists sessions', async () => {
        fetchMock.mockResolvedValue(respond([{ sessionId: 's1' }]));

        await expect(listSessions()).resolves.toEqual([{ sessionId: 's1' }]);
        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions`);
    });

    it('loads one session', async () => {
        await getSession('s1');

        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions/s1`);
        expect(lastCall()[1].method).toBeUndefined();
    });

    it('attaches a local file by path', async () => {
        // The encoder reads the source where it lies — nothing is uploaded, so
        // what crosses the wire is a path, not bytes.
        await ingestLocalFile('s1', '/Users/me/clip.mp4', 'sess_abc');

        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions/s1/local-file`);
        expect(lastCall()[1].method).toBe('POST');
        expect(JSON.parse(lastCall()[1].body as string)).toEqual({
            path: '/Users/me/clip.mp4',
        });
    });

    it('submits the encode config', async () => {
        const config = { type: 'video', segmentDuration: 6 } as EncodeConfig;

        await startEncode('s1', config, 'sess_abc');

        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions/s1/encode`);
        expect(JSON.parse(lastCall()[1].body as string)).toEqual(config);
    });

    it('deletes a session', async () => {
        await deleteSession('s1', 'sess_abc');

        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions/s1`);
        expect(lastCall()[1].method).toBe('DELETE');
    });

    it('reads no body back from a delete', async () => {
        const res = respond({});
        fetchMock.mockResolvedValue(res);

        await deleteSession('s1', 'sess_abc');

        expect(res.json).not.toHaveBeenCalled();
    });
});

describe('api — chapters', () => {
    it('reads the chapter sidecar for a language', async () => {
        fetchMock.mockResolvedValue(respond({ vtt: 'WEBVTT' }));

        await expect(getChapters('s1', 'en', 'sess_abc')).resolves.toEqual({
            vtt: 'WEBVTT',
        });
        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions/s1/chapters?lang=en`);
    });

    it('returns null when there are no chapters yet', async () => {
        // The common case — a session has none until someone writes some — so
        // it is an answer, not a failure.
        fetchMock.mockResolvedValue(respond({}, { ok: false, status: 404 }));

        await expect(getChapters('s1', 'en', 'sess_abc')).resolves.toBeNull();
    });

    it('still throws on any other failure', async () => {
        fetchMock.mockResolvedValue(respond({}, { ok: false, status: 500 }));

        await expect(getChapters('s1', 'en', 'sess_abc')).rejects.toThrow();
    });

    it('writes the chapter sidecar', async () => {
        await putChapters('s1', 'en', 'WEBVTT\n\n', 'sess_abc');

        expect(lastCall()[0]).toBe(`${API_BASE}/api/sessions/s1/chapters?lang=en`);
        expect(lastCall()[1].method).toBe('PUT');
        expect(JSON.parse(lastCall()[1].body as string)).toEqual({ vtt: 'WEBVTT\n\n' });
    });

    it('encodes a language tag that needs it', async () => {
        await getChapters('s1', 'pt-BR', 'sess_abc');

        expect(lastCall()[0]).toContain('lang=pt-BR');
    });
});

describe('api — errors', () => {
    it('surfaces the message the server sent', async () => {
        fetchMock.mockResolvedValue(
            respond({ message: 'Not enough disk space' }, { ok: false, status: 400 }),
        );

        await expect(startEncode('s1', {} as EncodeConfig, 'sess_abc')).rejects.toThrow(
            'Not enough disk space',
        );
    });

    it('falls back to a named prefix and the status code', async () => {
        fetchMock.mockResolvedValue(respond({}, { ok: false, status: 502 }));

        await expect(startEncode('s1', {} as EncodeConfig, 'sess_abc')).rejects.toThrow(
            'Encode start failed (502)',
        );
    });

    it('survives an error body that is not JSON at all', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 503,
            json: vi.fn().mockRejectedValue(new SyntaxError('not json')),
        } as unknown as Response);

        await expect(listSessions()).rejects.toThrow('Failed to list sessions (503)');
    });
});

describe('api — the event stream', () => {
    class FakeEventSource {
        static last: FakeEventSource | undefined;
        onmessage: ((e: { data: string }) => void) | null = null;
        onerror: ((e: Event) => void) | null = null;
        constructor(public url: string) {
            FakeEventSource.last = this;
        }
    }

    beforeEach(() => {
        FakeEventSource.last = undefined;
        vi.stubGlobal('EventSource', FakeEventSource);
    });

    it('carries the token in the query string', () => {
        // EventSource cannot set headers, so a token in the URL is the only way
        // a browser can authenticate a stream.
        subscribeSessionEvents('s1', 'sess_abc', vi.fn());

        expect(FakeEventSource.last!.url).toBe(
            `${API_BASE}/api/sessions/s1/events?token=sess_abc`,
        );
    });

    it('url-encodes a token that needs it', () => {
        subscribeSessionEvents('s1', 'sess a/b', vi.fn());

        expect(FakeEventSource.last!.url).toContain('token=sess%20a%2Fb');
    });

    it('hands parsed events to the caller', () => {
        const onEvent = vi.fn();
        subscribeSessionEvents('s1', 'sess_abc', onEvent);

        FakeEventSource.last!.onmessage!({ data: '{"status":"encoding"}' });

        expect(onEvent).toHaveBeenCalledWith({ status: 'encoding' });
    });

    it('ignores a malformed frame rather than tearing the stream down', () => {
        const onEvent = vi.fn();
        subscribeSessionEvents('s1', 'sess_abc', onEvent);

        expect(() => FakeEventSource.last!.onmessage!({ data: 'not json' })).not.toThrow();
        expect(onEvent).not.toHaveBeenCalled();
    });

    it('wires an error handler only when one is given', () => {
        subscribeSessionEvents('s1', 'sess_abc', vi.fn());
        expect(FakeEventSource.last!.onerror).toBeNull();

        const onError = vi.fn();
        subscribeSessionEvents('s1', 'sess_abc', vi.fn(), onError);
        expect(FakeEventSource.last!.onerror).toBe(onError);
    });
});
