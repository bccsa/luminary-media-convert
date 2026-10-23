<script setup lang="ts">
/**
 * The audio tracks of a post's existing video, opened by an edit session: one
 * row per track, its language and name, saved together, and a new track to add
 * from a file. Renaming changes only `LANGUAGE` and `NAME` in the master;
 * adding writes the new track beside the video and names it there.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { LanguageSelect } from '@luminary-media-converter/encode-config';
import { getEncodedMedia, putAudioTracks } from '../../api';
import type {
    AddAudioTrackJob,
    AudioTrack,
    AudioTrackEdit,
    EncodedMedia,
} from '../../types';
import AddAudioTrackForm from './AddAudioTrackForm.vue';

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

/** The track being added, while it is: renaming waits for it. */
const adding = computed(() =>
    media.value?.adding?.state === 'running' ? media.value.adding : null
);
const lastAdd = computed(() => media.value?.adding);
const showAddForm = ref(false);

const PHASES: Record<string, string> = {
    reading: 'Reading the video',
    encoding: 'Encoding',
    uploading: 'Uploading',
    saving: 'Adding it to the video',
};

/** Read again every second while a track is being added, until it is done. */
let poll: ReturnType<typeof setInterval> | undefined;
function stopPolling(): void {
    if (poll) clearInterval(poll);
    poll = undefined;
}
function startPolling(): void {
    if (poll) return;
    poll = setInterval(async () => {
        const token = props.sessionToken;
        if (!token) return;
        try {
            const next = await getEncodedMedia(props.sessionId, token);
            if (next.adding?.state !== 'running') {
                stopPolling();
                setRows(next);
                if (next.adding?.state === 'done') emit('saved');
            } else {
                media.value = next;
            }
        } catch {
            // The next tick asks again.
        }
    }, 1000);
}
watch(adding, (running) => (running ? startPolling() : undefined));
onBeforeUnmount(stopPolling);

function onAddStarted(job: AddAudioTrackJob): void {
    showAddForm.value = false;
    if (media.value) media.value = { ...media.value, adding: job };
    startPolling();
}

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
                    :disabled="edits.length === 0 || saving || !!adding"
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

        <div
            v-if="adding"
            class="rounded-lg border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-200"
            data-test="addingAudioTrack"
        >
            <p class="font-medium">
                Adding “{{ adding.name || 'the new track' }}”
                {{ adding.language ? `(${adding.language})` : '' }}…
            </p>
            <p>
                {{ PHASES[adding.phase] ?? adding.phase }}
                {{
                    adding.phase === 'encoding' || adding.phase === 'uploading'
                        ? `${adding.progress}%`
                        : ''
                }}
            </p>
        </div>
        <p
            v-else-if="lastAdd?.state === 'failed'"
            class="text-xs text-red-600 dark:text-red-400"
            data-test="addAudioTrackFailed"
        >
            The track “{{ lastAdd.name }}” was not added: {{ lastAdd.error }}
        </p>
        <p
            v-else-if="lastAdd?.state === 'done'"
            class="text-xs text-slate-500 dark:text-slate-400"
        >
            “{{ lastAdd.name }}” was added.
        </p>

        <AddAudioTrackForm
            v-if="showAddForm && media && !adding"
            :session-id="sessionId"
            :session-token="sessionToken"
            :etag="media.etag"
            @started="onAddStarted"
            @cancel="showAddForm = false"
        />
        <div v-else-if="media && !adding && !loading">
            <button
                type="button"
                class="chapter-toolbar-muted"
                data-test="showAddAudioTrack"
                @click="showAddForm = true"
            >
                + Add audio track
            </button>
        </div>

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
