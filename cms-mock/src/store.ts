import { reactive, ref, watch } from 'vue';
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    extractAnglePlaylist,
    extractAudioOnlyPlaylist,
    listVideoAngles,
    type VideoAngle,
} from '@luminary-media-converter/hls-core';
import type {
    CreateSessionResponse,
    LoggedEvent,
    MediaDto,
    SessionEvent,
    SessionForm,
} from './types';

const STORAGE_KEY = 'luminary-cms-mock';
const MAX_EVENTS = 500;

/** Deep-link the real CMS uses to launch the desktop app when it is not up. */
export const LAUNCH_URL = 'luminary-convert://';

function defaults(): { apiBaseUrl: string; form: SessionForm } {
    return {
        apiBaseUrl: 'http://127.0.0.1:31711',
        form: {
            documentId: 'demo-post-1',
            title: 'Demo Post',
            s3: {
                endPoint: '127.0.0.1',
                port: 9000,
                useSSL: false,
                bucket: 'media',
                region: 'us-east-1',
                accessKey: 'minioadmin',
                secretKey: 'minioadmin',
                pathPrefix: '',
            },
            publicBaseUrl: 'http://127.0.0.1:9000/media',
            requireEncryption: false,
            thumbnails: true,
            byteRange: true,
            byteRangeMaxFileSizeMB: 500,
            audioByteRangeMaxFileSizeMB: 50,
            segmentDuration: 6,
        },
    };
}

function loadPersisted(): { apiBaseUrl: string; form: SessionForm } {
    const base = defaults();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return base;
        const saved = JSON.parse(raw) as Partial<typeof base>;
        return {
            apiBaseUrl: saved.apiBaseUrl ?? base.apiBaseUrl,
            form: {
                ...base.form,
                ...(saved.form ?? {}),
                s3: { ...base.form.s3, ...(saved.form?.s3 ?? {}) },
            },
        };
    } catch {
        return base;
    }
}

const persisted = loadPersisted();

export const apiBaseUrl = ref(persisted.apiBaseUrl);
export const form = reactive<SessionForm>(persisted.form);

watch(
    [apiBaseUrl, form],
    () => {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({ apiBaseUrl: apiBaseUrl.value, form })
            );
        } catch {
            /* private mode / quota — persistence is a convenience only */
        }
    },
    { deep: true }
);

export const health = reactive({
    state: 'unknown' as 'unknown' | 'checking' | 'ok' | 'unreachable',
    apiVersion: '',
    error: '',
});

export const session = reactive({
    creating: false,
    error: '',
    response: null as CreateSessionResponse | null,
});

export const stream = reactive({
    state: 'idle' as 'idle' | 'connecting' | 'open' | 'error',
    events: [] as LoggedEvent[],
    media: null as MediaDto | null,
});

export const playback = reactive({
    checking: false,
    /** '' until a check has run. */
    state: '' as '' | 'unavailable' | 'ready',
    error: '',
    masterText: '',
    angles: [] as VideoAngle[],
    selectedAngleId: '',
    extractedText: '',
    audioOnlyText: null as string | null,
    /** Media playlist consulted for the `#EXT-X-KEY` line, when reachable. */
    variantUrl: '',
    keyLine: '' as string,
    hasPlaceholder: false,
});

function trimBase(): string {
    return apiBaseUrl.value.trim().replace(/\/+$/, '');
}

export async function checkHealth(): Promise<void> {
    health.state = 'checking';
    health.error = '';
    try {
        const res = await fetch(`${trimBase()}/api/cms/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { status: string; apiVersion: string };
        health.state = body.status === 'ok' ? 'ok' : 'unreachable';
        health.apiVersion = body.apiVersion ?? '';
    } catch (err) {
        health.state = 'unreachable';
        health.apiVersion = '';
        health.error = err instanceof Error ? err.message : String(err);
    }
}

/** Build the POST body, dropping empty optionals the way a real client would. */
function createSessionBody(): Record<string, unknown> {
    const s3: Record<string, unknown> = {
        endPoint: form.s3.endPoint,
        bucket: form.s3.bucket,
        accessKey: form.s3.accessKey,
        secretKey: form.s3.secretKey,
        useSSL: form.s3.useSSL,
    };
    if (form.s3.port !== null) s3.port = form.s3.port;
    if (form.s3.region.trim()) s3.region = form.s3.region.trim();
    if (form.s3.pathPrefix.trim()) s3.pathPrefix = form.s3.pathPrefix.trim();

    const body: Record<string, unknown> = {
        documentId: form.documentId,
        title: form.title,
        s3,
        publicBaseUrl: form.publicBaseUrl,
        encryption: { required: form.requireEncryption },
        thumbnails: form.thumbnails,
        byteRange: form.byteRange,
    };
    if (form.byteRangeMaxFileSizeMB !== null) {
        body.byteRangeMaxFileSizeMB = form.byteRangeMaxFileSizeMB;
    }
    if (form.audioByteRangeMaxFileSizeMB !== null) {
        body.audioByteRangeMaxFileSizeMB = form.audioByteRangeMaxFileSizeMB;
    }
    if (form.segmentDuration !== null) {
        body.segmentDuration = form.segmentDuration;
    }
    return body;
}

export async function createSession(): Promise<void> {
    session.creating = true;
    session.error = '';
    try {
        const res = await fetch(`${trimBase()}/api/cms/sessions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createSessionBody()),
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${text || res.statusText}`);
        }
        session.response = JSON.parse(text) as CreateSessionResponse;
        subscribe(session.response.eventsUrl);
    } catch (err) {
        session.error = err instanceof Error ? err.message : String(err);
    } finally {
        session.creating = false;
    }
}

let source: EventSource | null = null;
let nextEventId = 1;

export function disconnect(): void {
    source?.close();
    source = null;
    stream.state = 'idle';
}

/** Subscribe to the session's SSE stream. `eventsUrl` may be relative. */
export function subscribe(eventsUrl: string): void {
    disconnect();
    stream.events = [];
    stream.media = null;
    resetPlayback();

    const url = new URL(eventsUrl, `${trimBase()}/`).toString();
    stream.state = 'connecting';
    source = new EventSource(url);

    source.onopen = () => {
        stream.state = 'open';
    };
    // EventSource reconnects on its own; surface the gap rather than tearing down.
    source.onerror = () => {
        stream.state = 'error';
    };
    source.onmessage = (ev: MessageEvent<string>) => {
        stream.state = 'open';
        let data: SessionEvent;
        try {
            data = JSON.parse(ev.data) as SessionEvent;
        } catch {
            data = { raw: ev.data } as SessionEvent;
        }

        const isSavePoint = !stream.media && typeof data.hlsUrl === 'string';
        if (isSavePoint && data.hlsUrl) {
            // This is exactly where the real CMS writes its MediaDto.
            stream.media = { hlsUrl: data.hlsUrl, hlsKey: null };
            // The key no longer rides along on the event; it is asked for.
            void captureHlsKey(
                session.response?.sessionId ?? data.sessionId ?? ''
            );
        }

        stream.events.push({
            id: nextEventId++,
            at: new Date().toLocaleTimeString(),
            data,
            raw: JSON.stringify(data, null, 2),
            isSavePoint,
        });
        if (stream.events.length > MAX_EVENTS) {
            stream.events.splice(0, stream.events.length - MAX_EVENTS);
        }
    };
}

/**
 * Fetch the session's AES-128 key and record it against the saved media.
 *
 * The encoder stopped publishing the key on status reads and event frames: it
 * is served, masked, from its own endpoint, and the holder unmasks it. That is
 * the flow a real CMS has to implement, so the mock implements it too — right
 * at the save point, where the key used to arrive for free.
 *
 *     mask = SHA-256(sessionId)[0..15]
 *     key  = masked XOR mask          (XOR is its own inverse)
 *
 * Obscurity rather than security, and documented as such on the API side.
 */
async function captureHlsKey(sessionId: string): Promise<void> {
    const token = session.response?.readToken;
    if (!sessionId || !token) return;
    try {
        const res = await fetch(
            `${trimBase()}/api/sessions/${encodeURIComponent(sessionId)}/key` +
                `?token=${encodeURIComponent(token)}`
        );
        // 404 is the answer for a session encoded without encryption, and 401
        // for a credential this endpoint does not accept. Either way there is
        // no key to save, which `null` already says.
        if (!res.ok) return;
        const body = (await res.json()) as { maskedKeyHex?: string };
        if (!body.maskedKeyHex || !stream.media) return;
        stream.media.hlsKey = await unmaskKeyHex(sessionId, body.maskedKeyHex);
    } catch {
        /* encoder unreachable — the save point itself still stands */
    }
}

async function unmaskKeyHex(
    sessionId: string,
    maskedKeyHex: string
): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(sessionId)
    );
    const mask = new Uint8Array(digest).subarray(0, 16);
    const masked = new Uint8Array(maskedKeyHex.length >> 1);
    for (let i = 0; i < masked.length; i++) {
        masked[i] = parseInt(maskedKeyHex.substring(i * 2, i * 2 + 2), 16);
    }
    return Array.from(
        masked,
        (byte, i) => (byte ^ mask[i % mask.length]).toString(16).padStart(2, '0')
    ).join('');
}

function resetPlayback(): void {
    playback.state = '';
    playback.error = '';
    playback.masterText = '';
    playback.angles = [];
    playback.selectedAngleId = '';
    playback.extractedText = '';
    playback.audioOnlyText = null;
    playback.variantUrl = '';
    playback.keyLine = '';
    playback.hasPlaceholder = false;
}

/** First variant URI in a master, resolved against the master's own URL. */
function firstVariantUrl(masterText: string, masterUrl: string): string {
    const lines = masterText.split('\n').map((line) => line.trim());
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const uri = lines[i + 1];
        if (uri && !uri.startsWith('#')) return new URL(uri, masterUrl).toString();
    }
    return '';
}

export function selectAngle(angleId: string): void {
    playback.selectedAngleId = angleId;
    playback.extractedText = angleId
        ? extractAnglePlaylist(playback.masterText, angleId)
        : playback.masterText;
}

/**
 * Fetch the reported `hlsUrl` and prove the contract on the client side:
 * the URL is live, the angles are discoverable, and the encrypted variant
 * still carries the `luminary://key` placeholder for the player to swap.
 */
export async function checkPlayback(): Promise<void> {
    const hlsUrl = stream.media?.hlsUrl;
    if (!hlsUrl) return;

    playback.checking = true;
    resetPlayback();
    try {
        const res = await fetch(hlsUrl, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const masterText = await res.text();

        playback.masterText = masterText;
        playback.angles = listVideoAngles(masterText);
        playback.audioOnlyText = extractAudioOnlyPlaylist(masterText);
        selectAngle(
            playback.angles.find((a) => a.isDefault)?.id ??
                playback.angles[0]?.id ??
                ''
        );
        playback.state = 'ready';

        await inspectKey(masterText, hlsUrl);
    } catch (err) {
        playback.state = 'unavailable';
        playback.error = err instanceof Error ? err.message : String(err);
    } finally {
        playback.checking = false;
    }
}

/** Locate the `#EXT-X-KEY` line — it lives in the media playlist, not the master. */
async function inspectKey(masterText: string, masterUrl: string): Promise<void> {
    const fromMaster = findKeyLine(masterText);
    if (fromMaster) {
        playback.keyLine = fromMaster;
        playback.hasPlaceholder = fromMaster.includes(LUMINARY_KEY_PLACEHOLDER_URI);
        return;
    }

    const variantUrl = firstVariantUrl(masterText, masterUrl);
    if (!variantUrl) return;
    playback.variantUrl = variantUrl;
    try {
        const res = await fetch(variantUrl, { cache: 'no-store' });
        if (!res.ok) return;
        const keyLine = findKeyLine(await res.text());
        if (!keyLine) return;
        playback.keyLine = keyLine;
        playback.hasPlaceholder = keyLine.includes(LUMINARY_KEY_PLACEHOLDER_URI);
    } catch {
        /* variant unreachable — the master check above is still meaningful */
    }
}

function findKeyLine(playlistText: string): string {
    return (
        playlistText
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.startsWith('#EXT-X-KEY:')) ?? ''
    );
}

export { LUMINARY_KEY_PLACEHOLDER_URI };
