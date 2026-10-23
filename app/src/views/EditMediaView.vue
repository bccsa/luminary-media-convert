<script setup lang="ts">
/**
 * A post's existing video, opened from the CMS to change its chapters and its
 * audio tracks' languages and names. Nothing here encodes: the video's
 * segments stay as they are, and only the master playlist and the chapter
 * files are written.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { LanguageSelect } from '@luminary-media-converter/encode-config';
import type { PlayerSource } from '@luminary-media-converter/player-core';
import SessionPlayerStrip from '../components/session-view/SessionPlayerStrip.vue';
import { SegmentEditor } from '../components/segment-editor';
import { useChapters } from '../composables/useChapters';
import {
    getEncodedMedia,
    getSession,
    getSessionKey,
    listSessions,
    putAudioTracks,
} from '../api';
import { getSessionToken, setSessionToken } from '../session-tokens';
import { unmaskSessionKey } from '../utils/keyMask';
import type {
    AudioTrack,
    AudioTrackEdit,
    EncodedMedia,
    SessionStatusResponse,
} from '../types';

const route = useRoute();
const router = useRouter();
const sessionId = computed(() => String(route.params.id));

const session = ref<SessionStatusResponse | null>(null);
const sessionToken = ref<string | null>(null);
const media = ref<EncodedMedia | null>(null);
const keyHex = ref<string | undefined>();
const loadError = ref<string | null>(null);
const loading = ref(true);

/** One editable row per track: the track as read, and what it is being changed to. */
interface TrackRow {
    track: AudioTrack;
    language: string;
    name: string;
}
const rows = ref<TrackRow[]>([]);
const savingTracks = ref(false);
const tracksError = ref<string | null>(null);
const tracksSavedAt = ref<Date | null>(null);

const chapters = useChapters({
    getSessionToken: () => sessionToken.value ?? '',
});
const chaptersError = ref<string | null>(null);

const playerRef = ref<InstanceType<typeof SessionPlayerStrip> | null>(null);
const isPlaying = ref(false);
const duration = ref(0);
const selectedAudioTrack = ref(0);

const playerSource = computed<PlayerSource | null>(() => {
    const url = session.value?.hlsUrl;
    if (!url || (media.value?.encrypted && !keyHex.value)) return null;
    return {
        masterUrl: url,
        preservePosition: true,
        ...(keyHex.value ? { keyHex: keyHex.value } : {}),
    };
});

function setRows(next: EncodedMedia): void {
    media.value = next;
    rows.value = next.tracks.map((track) => ({
        track,
        language: track.language,
        name: track.name,
    }));
}

const trackEdits = computed<AudioTrackEdit[]>(() =>
    rows.value
        .filter(
            (row) =>
                row.language.trim() !== row.track.language ||
                row.name.trim() !== row.track.name
        )
        .map((row) => ({
            from: { language: row.track.language, name: row.track.name },
            to: { language: row.language.trim(), name: row.name.trim() },
        }))
);

async function resolveSessionToken(): Promise<string | null> {
    try {
        const list = await listSessions();
        for (const row of list)
            setSessionToken(row.sessionId, row.sessionToken);
        const mine = list.find((row) => row.sessionId === sessionId.value);
        if (mine) return mine.sessionToken;
    } catch {
        // The map may still hold a token from the list view.
    }
    return getSessionToken(sessionId.value) ?? null;
}

async function load(): Promise<void> {
    loading.value = true;
    loadError.value = null;
    try {
        const detail = await getSession(sessionId.value);
        // An encode has its own screen.
        if (detail.mode !== 'edit') {
            void router.replace(`/sessions/${sessionId.value}`);
            return;
        }
        session.value = detail;
        sessionToken.value = await resolveSessionToken();
        if (!sessionToken.value)
            throw new Error('This session can no longer be reached');

        setRows(await getEncodedMedia(sessionId.value, sessionToken.value));
        if (media.value?.encrypted) {
            const masked = await getSessionKey(
                sessionId.value,
                sessionToken.value
            );
            if (!masked?.maskedKeyHex) {
                throw new Error(
                    "The CMS did not send this video's key, so it cannot be played or edited"
                );
            }
            keyHex.value = await unmaskSessionKey(
                sessionId.value,
                masked.maskedKeyHex
            );
        }
        await chapters.load(sessionId.value);
    } catch (err) {
        loadError.value = (err as Error).message;
    } finally {
        loading.value = false;
    }
}

async function saveTracks(): Promise<void> {
    const token = sessionToken.value;
    if (!token || !media.value || trackEdits.value.length === 0) return;
    savingTracks.value = true;
    tracksError.value = null;
    try {
        setRows(
            await putAudioTracks(
                sessionId.value,
                token,
                media.value.etag,
                trackEdits.value
            )
        );
        tracksSavedAt.value = new Date();
        // The master the player holds is the one from before the save.
        playerRef.value?.reload?.();
    } catch (err) {
        tracksError.value = (err as Error).message;
    } finally {
        savingTracks.value = false;
    }
}

function resetTracks(): void {
    if (media.value) setRows(media.value);
    tracksError.value = null;
}

/** The video changed under this screen: show it as it is now, edits dropped. */
async function reloadTracks(): Promise<void> {
    if (!sessionToken.value) return;
    tracksError.value = null;
    try {
        setRows(await getEncodedMedia(sessionId.value, sessionToken.value));
    } catch (err) {
        tracksError.value = (err as Error).message;
    }
}

async function saveChapters(): Promise<void> {
    chaptersError.value = null;
    try {
        await chapters.saveRemote();
    } catch (err) {
        chaptersError.value = (err as Error).message;
    }
}

const isConflict = computed(() =>
    /changed since/i.test(tracksError.value ?? '')
);

onMounted(load);
onBeforeUnmount(() => chapters.unload());
</script>

<template>
    <div
        class="flex h-full min-h-0 flex-col gap-4 p-4"
        data-test="editMediaView"
    >
        <header class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="min-w-0">
                <p
                    class="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400"
                >
                    Edit video
                </p>
                <h1
                    class="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-100"
                >
                    {{ session?.title || 'Existing video' }}
                </h1>
            </div>
            <p class="max-w-prose text-xs text-zinc-500 dark:text-zinc-400">
                Only the chapters and the audio tracks' languages and names
                change. The video itself stays as it is, and players pick up the
                change the next time they load it.
            </p>
        </header>

        <p v-if="loading" class="text-sm text-zinc-500">Opening the video…</p>
        <p
            v-else-if="loadError"
            class="text-sm text-red-600 dark:text-red-400"
            data-test="editLoadError"
        >
            {{ loadError }}
        </p>

        <div
            v-else
            class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]"
        >
            <div class="flex min-h-0 flex-col gap-4">
                <SessionPlayerStrip
                    ref="playerRef"
                    class="min-h-[14rem] flex-1"
                    :source="playerSource"
                    :show-aside="false"
                    active-tab="chapters"
                    :show-audio-select="false"
                    :preview-audio-select-options="[]"
                    v-model:selected-audio-track="selectedAudioTrack"
                    @playing-change="isPlaying = $event"
                    @duration-change="duration = $event"
                />

                <section
                    class="rounded-lg border border-zinc-200 p-3 dark:border-zinc-700"
                    data-test="editAudioTracks"
                >
                    <div class="mb-2 flex items-center justify-between gap-2">
                        <h2
                            class="text-sm font-semibold text-zinc-900 dark:text-zinc-100"
                        >
                            Audio tracks
                        </h2>
                        <div class="flex items-center gap-2">
                            <span
                                v-if="tracksSavedAt && trackEdits.length === 0"
                                class="text-xs text-zinc-500"
                            >
                                Saved
                            </span>
                            <button
                                v-if="trackEdits.length > 0"
                                type="button"
                                class="chapter-toolbar-muted"
                                :disabled="savingTracks"
                                @click="resetTracks"
                            >
                                Discard
                            </button>
                            <button
                                type="button"
                                class="chapter-save-btn"
                                :disabled="
                                    trackEdits.length === 0 || savingTracks
                                "
                                data-test="editSaveTracks"
                                @click="saveTracks"
                            >
                                {{
                                    savingTracks
                                        ? 'Saving…'
                                        : 'Save audio tracks'
                                }}
                            </button>
                        </div>
                    </div>

                    <p v-if="rows.length === 0" class="text-sm text-zinc-500">
                        This video has no separate audio tracks to name.
                    </p>
                    <table v-else class="w-full text-sm">
                        <thead>
                            <tr
                                class="text-left text-xs text-zinc-500 dark:text-zinc-400"
                            >
                                <th class="pb-1 font-medium">Language</th>
                                <th class="pb-1 font-medium">Name</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in rows"
                                :key="`${row.track.language}|${row.track.name}`"
                            >
                                <td class="w-48 py-1 pr-2">
                                    <LanguageSelect
                                        v-model="row.language"
                                        :aria-label="`Language of ${row.track.name}`"
                                    />
                                </td>
                                <td class="py-1">
                                    <input
                                        v-model="row.name"
                                        type="text"
                                        maxlength="100"
                                        class="w-full rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-600 dark:bg-zinc-900"
                                        :aria-label="`Name of ${row.track.name}`"
                                    />
                                </td>
                            </tr>
                        </tbody>
                    </table>
                    <p
                        v-if="tracksError"
                        class="mt-2 text-xs text-red-600 dark:text-red-400"
                    >
                        {{ tracksError }}
                        <button
                            v-if="isConflict"
                            type="button"
                            class="underline"
                            @click="reloadTracks"
                        >
                            Show it as it is now
                        </button>
                    </p>
                </section>
            </div>

            <section
                class="flex min-h-0 flex-col gap-2"
                data-test="editChapters"
            >
                <SegmentEditor
                    v-model="chapters.segments.value"
                    class="min-h-0 flex-1 overflow-hidden"
                    mode="chapters"
                    embedded
                    :duration="duration"
                    :get-current-time="() => playerRef?.getCurrentTime() ?? 0"
                    :on-seek="(t: number) => playerRef?.seek(t)"
                    :on-play-pause="() => playerRef?.togglePlay()"
                    :is-playing="isPlaying"
                    :ripple-edit="false"
                    :show-help="false"
                    title="Chapters"
                    empty-title="No chapters yet"
                    empty-hint="Mark in and out on the timeline to add a chapter."
                    keyboard-scope="focus"
                >
                    <template #list-actions>
                        <span
                            v-if="chapters.isDirty.value"
                            class="chapter-unsaved-pill"
                            title="Unsaved changes are kept on this computer until you save."
                        >
                            Unsaved
                        </span>
                        <button
                            v-if="chapters.isDirty.value"
                            type="button"
                            class="chapter-toolbar-muted"
                            :disabled="chapters.isSaving.value"
                            @click="chapters.discardLocal()"
                        >
                            Discard
                        </button>
                        <button
                            type="button"
                            class="chapter-save-btn"
                            :disabled="
                                !chapters.isDirty.value ||
                                chapters.isSaving.value
                            "
                            data-test="editSaveChapters"
                            @click="saveChapters"
                        >
                            {{
                                chapters.isSaving.value
                                    ? 'Saving…'
                                    : 'Save chapters'
                            }}
                        </button>
                    </template>
                </SegmentEditor>
                <p
                    v-if="chaptersError"
                    class="text-xs text-red-600 dark:text-red-400"
                >
                    {{ chaptersError }}
                </p>
            </section>
        </div>
    </div>
</template>
