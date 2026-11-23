import { computed, reactive, ref, watch } from 'vue';
import {
    LUMINARY_KEY_PLACEHOLDER_URI,
    extractAnglePlaylist,
    extractAudioOnlyPlaylist,
    listVideoAngles,
    type VideoAngle,
} from '@luminary-media-converter/hls-core';
import type {
    CreateSessionResponse,
    FollowedSession,
    LoggedEvent,
    MediaDto,
    SessionEvent,
    SessionForm,
    StoreKind,
} from './types';

const STORAGE_KEY = 'luminary-cms-mock';
const MAX_EVENTS = 500;

/** Deep-link the real CMS uses to launch the desktop app when it is not up. */
export const LAUNCH_URL = 'luminary-convert://';

interface Persisted {
    apiBaseUrl: string;
    form: SessionForm;
    /** The mock's documents: what each one has stored for its video, by documentId. */
    documents: Record<string, MediaDto>;
    followed: FollowedSession;
}

function noSession(): FollowedSession {
    return { sessionId: '', readToken: '', eventsUrl: '', documentId: '' };
}

function defaults(): Persisted {
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
            byteRangeBlockSeconds: null,
            segmentDuration: 6,
            mode: 'encode',
            existingMedia: { hlsUrl: '', hlsKey: '' },
        },
        documents: {},
        followed: noSession(),
    };
}

function loadPersisted(): Persisted {
    const base = defaults();
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return base;
        const saved = JSON.parse(raw) as Partial<Persisted>;
        return {
            apiBaseUrl: saved.apiBaseUrl ?? base.apiBaseUrl,
            form: {
                ...base.form,
                ...(saved.form ?? {}),
                s3: { ...base.form.s3, ...(saved.form?.s3 ?? {}) },
                existingMedia: {
                    ...base.form.existingMedia,
                    ...(saved.form?.existingMedia ?? {}),
                },
            },
            documents: saved.documents ?? base.documents,
            followed: { ...base.followed, ...(saved.followed ?? {}) },
        };
    } catch {
        return base;
    }
}

const persisted = loadPersisted();

export const apiBaseUrl = ref(persisted.apiBaseUrl);
export const form = reactive<SessionForm>(persisted.form);
export const documents = reactive<Record<string, MediaDto>>(persisted.documents);
/** The session this page follows; all empty when it follows none. */
export const followed = reactive<FollowedSession>(persisted.followed);

watch(
    [apiBaseUrl, form, documents, followed],
    () => {
        try {
            localStorage.setItem(
                STORAGE_KEY,
                JSON.stringify({
                    apiBaseUrl: apiBaseUrl.value,
                    form,
                    documents,
                    followed,
                })
            );
        } catch {
            /* private mode / quota — persistence is a convenience only */
        }
    },
    { deep: true }
);

/** What the followed session's document has stored, else the form's document. */
export const storedMedia = computed<MediaDto | null>(
    () => documents[followed.documentId || form.documentId] ?? null
);

/** Pre-fill edit mode's `existingMedia` from what the form's document has stored. */
export function fillExistingMedia(): void {
    const media = documents[form.documentId];
    if (!media) return;
    form.existingMedia.hlsUrl = media.hlsUrl;
    form.existingMedia.hlsKey = media.hlsKey ?? '';
}

// Switching to edit with nothing filled in opens the video the document holds.
watch(
    () => form.mode,
    (mode) => {
        if (mode === 'edit' && !form.existingMedia.hlsUrl.trim()) fillExistingMedia();
    }
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
    /** The `existingMedia.hlsUrl` an edit session was asked to open. */
    requestedHlsUrl: '',
});

export const stream = reactive({
    state: 'idle' as 'idle' | 'connecting' | 'open' | 'error',
    events: [] as LoggedEvent[],
    /** Why the followed session was forgotten, when it was. */
    notice: '',
});

/**
 * Acknowledging stored versions to the encoder. Switched off, no acks go out:
 * the encoder's session stays pending, so a save there waits ~10 s and answers
 * `published: false`, and the save after it is refused. Not persisted — a
 * reload always starts with it on.
 */
export const ack = reactive({
    enabled: true,
    /** Outcome of the last ack sent. */
    state: '' as '' | 'acked' | 'unsupported' | 'error',
    hlsUrl: '',
    at: '',
    detail: '',
});

// Turning it back on acks the version the document holds now.
watch(
    () => ack.enabled,
    (on) => {
        const media = documents[followed.documentId];
        if (on && media) void acknowledge(media.hlsUrl, true);
    }
);

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

function sessionUrl(sessionId: string, path: string, readToken: string): string {
    return (
        `${trimBase()}/api/sessions/${encodeURIComponent(sessionId)}${path}` +
        `?token=${encodeURIComponent(readToken)}`
    );
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
    // An emptied number input holds '' rather than null.
    if (typeof form.byteRangeBlockSeconds === 'number') {
        body.byteRangeBlockSeconds = form.byteRangeBlockSeconds;
    }
    if (form.segmentDuration !== null) {
        body.segmentDuration = form.segmentDuration;
    }
    if (form.mode === 'edit') {
        const existingMedia: Record<string, unknown> = {
            hlsUrl: form.existingMedia.hlsUrl.trim(),
        };
        const hlsKey = form.existingMedia.hlsKey.trim();
        if (hlsKey) existingMedia.hlsKey = hlsKey;
        body.mode = 'edit';
        body.existingMedia = existingMedia;
    }
    return body;
}

export async function createSession(): Promise<void> {
    const documentId = form.documentId;
    session.creating = true;
    session.error = '';
    session.requestedHlsUrl =
        form.mode === 'edit' ? form.existingMedia.hlsUrl.trim() : '';
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
        const response = JSON.parse(text) as CreateSessionResponse;
        session.response = response;
        follow({
            sessionId: response.sessionId,
            readToken: response.readToken,
            eventsUrl: response.eventsUrl,
            documentId,
        });
        // Edit mode names the revision it opened, which may be newer than the
        // one sent. Stored (and acknowledged) like any announced URL.
        if (response.hlsUrl) announce(response.hlsUrl);
    } catch (err) {
        session.error = err instanceof Error ? err.message : String(err);
    } finally {
        session.creating = false;
    }
}

let source: EventSource | null = null;
let nextEventId = 1;
/** The `hlsUrl` being stored right now; its ack follows the store. */
let storing = '';
/** The `hlsUrl` last acknowledged on this connection, so events do not repeat it. */
let ackedOnConnection = '';

export function disconnect(): void {
    source?.close();
    source = null;
    stream.state = 'idle';
}

/**
 * Follow a session's SSE stream. `eventsUrl` may be relative.
 *
 * A completed or failed session is followed like any other: an edit after an
 * encode finished still announces a new `hlsUrl`. Only the encoder saying it
 * no longer holds the session, or that it is for another document, ends it.
 */
export function follow(handle: FollowedSession): void {
    disconnect();
    Object.assign(followed, handle);
    stream.events = [];
    stream.notice = '';
    ackedOnConnection = '';
    resetPlayback();

    const url = new URL(handle.eventsUrl, `${trimBase()}/`).toString();
    stream.state = 'connecting';
    const es = new EventSource(url);
    source = es;

    es.onopen = () => {
        if (source !== es) return;
        stream.state = 'open';
        // The first event on a connection is the session as it stands now;
        // a URL already stored is acknowledged again from it.
        ackedOnConnection = '';
    };
    es.onerror = () => {
        if (source !== es) return;
        stream.state = 'error';
        // EventSource retries a dropped connection by itself, but gives up for
        // good on an HTTP error — which is how an encoder that no longer holds
        // the session answers. Only then is it worth asking whether to forget.
        if (es.readyState === EventSource.CLOSED) {
            const gone = { ...followed };
            void goneReason(gone).then((reason) => {
                if (reason && followed.sessionId === gone.sessionId) forget(reason);
            });
        }
    };
    es.onmessage = (ev: MessageEvent<string>) => {
        if (source !== es) return;
        stream.state = 'open';
        let data: SessionEvent;
        try {
            data = JSON.parse(ev.data) as SessionEvent;
        } catch {
            data = { raw: ev.data } as SessionEvent;
        }

        const stored =
            typeof data.hlsUrl === 'string' && data.hlsUrl
                ? announce(data.hlsUrl)
                : null;

        stream.events.push({
            id: nextEventId++,
            at: new Date().toLocaleTimeString(),
            data,
            raw: JSON.stringify(data, null, 2),
            stored,
        });
        if (stream.events.length > MAX_EVENTS) {
            stream.events.splice(0, stream.events.length - MAX_EVENTS);
        }
    };
}

export function reconnect(): void {
    if (followed.sessionId) follow({ ...followed });
}

function forget(reason: string): void {
    disconnect();
    Object.assign(followed, noSession());
    stream.notice = reason;
}

/**
 * Why a session is no longer worth following, or '' while it still is. An
 * encoder that is merely not running answers nothing, and keeps the handle.
 */
async function goneReason(handle: FollowedSession): Promise<string> {
    if (!handle.sessionId) return '';
    try {
        const res = await fetch(sessionUrl(handle.sessionId, '', handle.readToken));
        // A session the encoder dropped (deleted, replaced, or purged at a
        // restart) takes its read token with it, so the auth guard answers 401
        // before the route can say 404. Both mean it is gone.
        if (res.status === 404 || res.status === 401) {
            return `The encoder no longer holds session ${handle.sessionId} (HTTP ${res.status}), so it was forgotten.`;
        }
        if (!res.ok) return '';
        const body = (await res.json()) as { documentId?: string };
        if (body.documentId && body.documentId !== handle.documentId) {
            return `Session ${handle.sessionId} is for document ${body.documentId}, not ${handle.documentId}, so it was forgotten.`;
        }
        return '';
    } catch {
        return '';
    }
}

/** Pick the remembered session up again after a reload, finished or not. */
export async function resume(): Promise<void> {
    if (!followed.sessionId) return;
    const handle = { ...followed };
    const reason = await goneReason(handle);
    // A session created while the check was out takes precedence.
    if (followed.sessionId !== handle.sessionId) return;
    if (reason) forget(reason);
    else follow(handle);
}

/** Everything up to the last `/` of the URL's path: the video's folder. */
function folderOf(url: string): string {
    const path = url.split(/[?#]/, 1)[0];
    return path.slice(0, path.lastIndexOf('/') + 1);
}

/**
 * Handle an `hlsUrl` the encoder announced (an event, or an edit session's
 * create response). It changes on every edit, so every new value is stored,
 * and then acknowledged — the encoder refuses the next save until it is.
 *
 * The real CMS splits on the folder:
 * - **Same folder** as the stored URL (a new `master_rN.m3u8` of the same
 *   video): it auto-saves the media field alone, at once, then acks.
 * - **Another folder, or nothing stored** (a new encode or a re-encode): it
 *   writes the URL onto the open document and acks after the editor's own
 *   Save. Auto-saving there would be wrong, because the Luminary API deletes
 *   the old folder as soon as a document's URL leaves it — the live video
 *   would go before the new one exists.
 * The mock has no editor Save, so it stores both at once; the log shows which
 * of the two the real CMS would have done.
 *
 * Returns how the URL was stored, or null when the document already held it.
 */
function announce(hlsUrl: string): StoreKind | null {
    const documentId = followed.documentId;
    if (!documentId) return null;
    const held = documents[documentId];
    if (held?.hlsUrl === hlsUrl) {
        void acknowledge(hlsUrl);
        return null;
    }

    const kind: StoreKind =
        held && folderOf(held.hlsUrl) === folderOf(hlsUrl) ? 'same-folder' : 'new-folder';
    // A revision of the same video keeps its key; a new folder brings its own.
    documents[documentId] = {
        hlsUrl,
        hlsKey: kind === 'same-folder' ? held!.hlsKey : null,
    };
    resetPlayback();
    storing = hlsUrl;
    void captureHlsKey(documentId, hlsUrl).finally(() => {
        if (storing === hlsUrl) storing = '';
        void acknowledge(hlsUrl);
    });
    return kind;
}

/**
 * Tell the encoder this document has stored `hlsUrl`:
 * `POST /api/sessions/:id/ack?token=<readToken>` with `{ hlsUrl }`.
 *
 * Only ever for the URL the document holds. A 404 is an encoder from before
 * the route (or a session it no longer has) and is ignored, as the real CMS
 * must, since it ships first.
 */
async function acknowledge(hlsUrl: string, force = false): Promise<void> {
    const { sessionId, readToken, documentId } = followed;
    if (!ack.enabled || !sessionId || !readToken) return;
    if (documents[documentId]?.hlsUrl !== hlsUrl) return;
    // Mid-store: the store acks when it is done.
    if (storing === hlsUrl) return;
    if (!force && ackedOnConnection === hlsUrl) return;
    ackedOnConnection = hlsUrl;

    try {
        const res = await fetch(sessionUrl(sessionId, '/ack', readToken), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hlsUrl }),
        });
        if (res.status === 404) {
            ack.state = 'unsupported';
            ack.detail = 'HTTP 404: an encoder without the ack route, or a session it no longer holds. Ignored.';
        } else if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        } else {
            ack.state = 'acked';
            ack.detail = '';
        }
        ack.hlsUrl = hlsUrl;
        ack.at = new Date().toLocaleTimeString();
    } catch (err) {
        ack.state = 'error';
        ack.hlsUrl = hlsUrl;
        ack.at = new Date().toLocaleTimeString();
        ack.detail = err instanceof Error ? err.message : String(err);
        // Let the next event try again.
        if (ackedOnConnection === hlsUrl) ackedOnConnection = '';
    }
}

/**
 * Fetch the session's AES-128 key and record it against the stored media.
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
async function captureHlsKey(documentId: string, hlsUrl: string): Promise<void> {
    const { sessionId, readToken } = followed;
    if (!sessionId || !readToken) return;
    try {
        const res = await fetch(sessionUrl(sessionId, '/key', readToken));
        // 404 is the answer for a session encoded without encryption, and 401
        // for a credential this endpoint does not accept. Either way there is
        // no key to save, which `null` (or the revision's kept key) already says.
        if (!res.ok) return;
        const body = (await res.json()) as { maskedKeyHex?: string };
        const media = documents[documentId];
        // Overtaken by a newer URL while the key was on its way.
        if (!body.maskedKeyHex || media?.hlsUrl !== hlsUrl) return;
        media.hlsKey = await unmaskKeyHex(sessionId, body.maskedKeyHex);
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
 * Fetch the stored `hlsUrl` and prove the contract on the client side:
 * the URL is live, the angles are discoverable, and the encrypted variant
 * still carries the `luminary://key` placeholder for the player to swap.
 */
export async function checkPlayback(): Promise<void> {
    const hlsUrl = storedMedia.value?.hlsUrl;
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
