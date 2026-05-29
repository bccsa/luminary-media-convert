import { ref, watch, type Ref } from 'vue';
import {
    type Segment,
    parseVtt,
    exportChaptersVtt,
} from '@luminary-media-converter/segment-editor';
import { getSessionChapters, putSessionChapters } from '../api';
import { errorMessage } from '../utils/errors';

const STORAGE_KEY_PREFIX = 'luminary_chapters_';
const AUTOSAVE_DEBOUNCE_MS = 2000;

interface StoredEntry {
    lang: string;
    segments: Segment[];
    /** ISO timestamp of the last localStorage write. */
    updatedAt: string;
}

function storageKey(sessionId: string): string {
    return `${STORAGE_KEY_PREFIX}${sessionId}`;
}

function readLocal(sessionId: string): StoredEntry | null {
    try {
        const raw = localStorage.getItem(storageKey(sessionId));
        if (!raw) return null;
        const entry = JSON.parse(raw) as StoredEntry;
        if (!Array.isArray(entry?.segments)) return null;
        return entry;
    } catch {
        return null;
    }
}

function writeLocal(sessionId: string, entry: StoredEntry): void {
    try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(entry));
    } catch {
        // Quota / disabled storage — silently ignore (matches encode-config layoutStorage).
    }
}

function clearLocal(sessionId: string): void {
    try {
        localStorage.removeItem(storageKey(sessionId));
    } catch {
        // ignore
    }
}

/** Remove persisted chapter draft for a session (e.g. after delete or from session list). */
export function clearChapterDraftForSession(sessionId: string): void {
    clearLocal(sessionId);
}

export interface UseChaptersOptions {
    /** Default 'en'. */
    lang?: string;
    /**
     * Async getter for the current access token. Called fresh on every API
     * call so long edit sessions don't run with a stale bearer.
     */
    getAccessToken: () => Promise<string>;
    /** Test seam — provide an alternate fetch for the SaaS proxy. */
    fetchRemote?: (sessionId: string, lang: string, token: string) => Promise<{ vtt: string } | null>;
    /** Test seam — provide an alternate uploader. */
    saveRemoteImpl?: (sessionId: string, lang: string, vtt: string, token: string) => Promise<void>;
    /** Override the autosave debounce window (ms). Useful in tests. */
    autosaveMs?: number;
}

/**
 * Owns chapter editing state for a single session, with localStorage as the
 * dirty buffer and S3 (via the SaaS proxy) as the canonical store.
 *
 * Load priority (v1): if localStorage has an entry for the session, the editor
 * opens with those segments + isDirty=true. Only `saveRemote` (success) or
 * `discardLocal` clears the dirty state.
 */
export function useChapters(opts: UseChaptersOptions) {
    const lang = opts.lang ?? 'en';
    const autosaveMs = opts.autosaveMs ?? AUTOSAVE_DEBOUNCE_MS;
    const getAccessToken = opts.getAccessToken;

    const segments: Ref<Segment[]> = ref([]);
    const isDirty = ref(false);
    const isSaving = ref(false);
    const lastSavedAt: Ref<Date | null> = ref(null);
    const loadError: Ref<string | null> = ref(null);
    const isLoaded = ref(false);
    /** Session id that `segments` currently reflect; drives reload when route id changes. */
    const loadedSessionId: Ref<string | null> = ref(null);

    let activeSessionId: string | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let suppressAutosave = false;
    /** Bumped by `unload()` and at each `load()` start so stale async work is ignored. */
    let loadEpoch = 0;

    const fetchRemote = opts.fetchRemote
        ?? ((sessionId: string, l: string, token: string) => getSessionChapters(token, sessionId, l));
    const saveRemoteImpl = opts.saveRemoteImpl
        ?? ((sessionId: string, l: string, vtt: string, token: string) =>
            putSessionChapters(token, sessionId, vtt, l));

    async function load(sessionId: string): Promise<void> {
        const epoch = ++loadEpoch;
        activeSessionId = sessionId;
        loadError.value = null;
        suppressAutosave = true;

        const local = readLocal(sessionId);
        if (local) {
            if (epoch !== loadEpoch || activeSessionId !== sessionId) return;
            segments.value = local.segments;
            isDirty.value = true;
            isLoaded.value = true;
            loadedSessionId.value = sessionId;
            queueMicrotask(() => {
                suppressAutosave = false;
            });
            return;
        }

        try {
            const token = await getAccessToken();
            if (epoch !== loadEpoch || activeSessionId !== sessionId) return;
            const remote = await fetchRemote(sessionId, lang, token);
            if (epoch !== loadEpoch || activeSessionId !== sessionId) return;
            segments.value = remote?.vtt ? parseVtt(remote.vtt) : [];
            isDirty.value = false;
        } catch (err) {
            if (epoch !== loadEpoch) return;
            segments.value = [];
            loadError.value = errorMessage(err);
        } finally {
            if (epoch === loadEpoch) {
                isLoaded.value = true;
                loadedSessionId.value = sessionId;
                queueMicrotask(() => {
                    suppressAutosave = false;
                });
            }
        }
    }

    function saveLocal(): void {
        if (!activeSessionId) return;
        writeLocal(activeSessionId, {
            lang,
            segments: segments.value,
            updatedAt: new Date().toISOString(),
        });
    }

    async function saveRemote(): Promise<void> {
        if (!activeSessionId) return;
        isSaving.value = true;
        try {
            const vtt = exportChaptersVtt(segments.value);
            const token = await getAccessToken();
            await saveRemoteImpl(activeSessionId, lang, vtt, token);
            isDirty.value = false;
            lastSavedAt.value = new Date();
            clearLocal(activeSessionId);
        } finally {
            isSaving.value = false;
        }
    }

    async function discardLocal(): Promise<void> {
        if (!activeSessionId) return;
        clearLocal(activeSessionId);
        suppressAutosave = true;
        try {
            const token = await getAccessToken();
            const remote = await fetchRemote(activeSessionId, lang, token);
            segments.value = remote?.vtt ? parseVtt(remote.vtt) : [];
            isDirty.value = false;
        } finally {
            queueMicrotask(() => { suppressAutosave = false; });
        }
    }

    function unload(): void {
        loadEpoch++;
        suppressAutosave = false;
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
        activeSessionId = null;
        segments.value = [];
        isDirty.value = false;
        isSaving.value = false;
        lastSavedAt.value = null;
        loadError.value = null;
        isLoaded.value = false;
        loadedSessionId.value = null;
    }

    // Autosave — debounced. Mark dirty immediately so the UI reacts; commit
    // to localStorage after the debounce window. `suppressAutosave` lets
    // load() / discardLocal() seed segments without re-triggering the loop.
    watch(
        segments,
        () => {
            if (suppressAutosave || !activeSessionId) return;
            isDirty.value = true;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                saveLocal();
            }, autosaveMs);
        },
        { deep: true },
    );

    return {
        segments,
        isDirty,
        isSaving,
        lastSavedAt,
        loadError,
        isLoaded,
        loadedSessionId,
        load,
        saveRemote,
        discardLocal,
        unload,
    };
}
