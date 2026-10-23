<script setup lang="ts">
/**
 * The audio tracks of a post's existing video, opened by an edit session: one
 * row per track, its language and name, saved together. Only `LANGUAGE` and
 * `NAME` change in the master; the video itself stays as it is.
 */
import { computed, ref, watch } from 'vue';
import { LanguageSelect } from '@luminary-media-converter/encode-config';
import { getEncodedMedia, putAudioTracks } from '../../api';
import type { AudioTrack, AudioTrackEdit, EncodedMedia } from '../../types';

const props = defineProps<{
    sessionId: string;
    sessionToken: string | null;
}>();

const emit = defineEmits<{
    /** The master changed: whatever holds the old one should load it again. */
    saved: [];
}>();

/** One editable row per track: the track as read, and what it is being changed to. */
interface TrackRow {
    track: AudioTrack;
    language: string;
    name: string;
}

const media = ref<EncodedMedia | null>(null);
const rows = ref<TrackRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const savedAt = ref<Date | null>(null);

function setRows(next: EncodedMedia): void {
    media.value = next;
    rows.value = next.tracks.map((track) => ({
        track,
        language: track.language,
        name: track.name,
    }));
}

const edits = computed<AudioTrackEdit[]>(() =>
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

/** The video changed since it was read: saving over it is refused until it is read again. */
const isConflict = computed(() => /changed since/i.test(error.value ?? ''));

async function load(): Promise<void> {
    const token = props.sessionToken;
    if (!token) return;
    loading.value = true;
    error.value = null;
    try {
        setRows(await getEncodedMedia(props.sessionId, token));
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        loading.value = false;
    }
}

async function save(): Promise<void> {
    const token = props.sessionToken;
    if (!token || !media.value || edits.value.length === 0) return;
    saving.value = true;
    error.value = null;
    try {
        setRows(
            await putAudioTracks(
                props.sessionId,
                token,
                media.value.etag,
                edits.value
            )
        );
        savedAt.value = new Date();
        emit('saved');
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        saving.value = false;
    }
}

function discard(): void {
    if (media.value) setRows(media.value);
    error.value = null;
}

watch(() => [props.sessionId, props.sessionToken] as const, load, {
    immediate: true,
});
</script>

<template>
    <div
        class="flex min-h-0 flex-1 flex-col gap-2"
        data-test="audioTracksPanel"
    >
        <div class="flex items-center justify-between gap-2">
            <p class="text-xs text-slate-500 dark:text-slate-400">
                The language and name each audio track is offered under.
            </p>
            <div class="flex shrink-0 items-center gap-2">
                <span
                    v-if="savedAt && edits.length === 0"
                    class="text-xs text-slate-500 dark:text-slate-400"
                    >Saved</span
                >
                <button
                    v-if="edits.length > 0"
                    type="button"
                    class="chapter-toolbar-muted"
                    :disabled="saving"
                    @click="discard"
                >
                    Discard
                </button>
                <button
                    type="button"
                    class="chapter-save-btn"
                    :disabled="edits.length === 0 || saving"
                    data-test="saveAudioTracks"
                    @click="save"
                >
                    {{ saving ? 'Saving…' : 'Save audio tracks' }}
                </button>
            </div>
        </div>

        <p v-if="loading" class="text-sm text-slate-500">Reading the video…</p>
        <p
            v-else-if="media && rows.length === 0"
            class="text-sm text-slate-500"
        >
            This video has no separate audio tracks to name.
        </p>
        <table v-else-if="rows.length > 0" class="w-full text-sm">
            <thead>
                <tr
                    class="text-left text-xs text-slate-500 dark:text-slate-400"
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
                    <td class="w-32 py-1 pr-2">
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
                            class="w-full rounded border border-slate-300 bg-white px-2 py-1 dark:border-slate-600 dark:bg-slate-900"
                            :aria-label="`Name of ${row.track.name}`"
                        />
                    </td>
                </tr>
            </tbody>
        </table>

        <p v-if="error" class="text-xs text-red-600 dark:text-red-400">
            {{ error }}
            <button
                v-if="isConflict"
                type="button"
                class="underline"
                @click="load"
            >
                Show it as it is now
            </button>
        </p>
    </div>
</template>
