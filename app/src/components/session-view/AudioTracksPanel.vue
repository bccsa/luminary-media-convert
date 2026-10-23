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
import AddAudioTrackModal from './AddAudioTrackModal.vue';

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
/** The dialog that adds a track. */
const addOpen = ref(false);

const PHASES: Record<string, string> = {
    reading: 'Reading the video',
    encoding: 'Encoding',
    uploading: 'Uploading',
    saving: 'Adding it',
};

/** The progress the adding row shows, as the chapter rows show a duration. */
const addingLabel = computed(() => {
    const job = adding.value;
    if (!job) return '';
    const phase = PHASES[job.phase] ?? job.phase;
    return job.phase === 'encoding' || job.phase === 'uploading'
        ? `${phase} ${job.progress}%`
        : `${phase}…`;
});

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
    <!-- The chapter list's card, so the two tabs read as one editor. -->
    <div
        class="mt-3.5 flex min-h-0 flex-auto flex-col overflow-hidden rounded-[10px] border border-sky-200 bg-white/96 px-5 pt-2 pb-4 shadow-[0_1px_2px_rgb(9_9_11/0.04),0_0_0_1px_rgb(9_9_11/0.06)] dark:border-sky-400/12 dark:bg-[rgba(30,41,55,0.82)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_8px_30px_rgb(0_0_0/0.25)]"
        data-test="audioTracksPanel"
    >
        <div
            class="m-0 mb-2.5 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sky-200 pt-0.5 pb-2 dark:border-sky-400/12"
        >
            <div class="flex min-w-0 flex-wrap items-baseline gap-2">
                <h3
                    class="m-0 text-[0.9375rem] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-slate-200"
                >
                    Audio tracks
                </h3>
                <span class="text-xs text-slate-500 dark:text-slate-400">
                    <template v-if="rows.length > 0">
                        {{ rows.length }} track{{
                            rows.length !== 1 ? 's' : ''
                        }}
                    </template>
                    <template v-else-if="media">No tracks</template>
                    <template v-if="savedAt && edits.length === 0">
                        · Saved</template
                    >
                </span>
            </div>
            <div class="ml-auto flex items-center gap-1.5">
                <span
                    v-if="edits.length > 0"
                    class="chapter-unsaved-pill"
                    title="Changes stay here until you save them."
                >
                    Unsaved
                </span>
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
                    class="chapter-toolbar-muted"
                    :disabled="!media || !!adding || loading"
                    :title="
                        adding
                            ? 'A track is being added'
                            : 'Add a track from a file or a link'
                    "
                    data-test="showAddAudioTrack"
                    @click="addOpen = true"
                >
                    + Add track
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

        <p v-if="loading" class="px-2 text-xs text-slate-500">
            Reading the video…
        </p>

        <div
            v-else-if="rows.length > 0 || adding"
            class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
            <div
                v-for="(row, i) in rows"
                :key="`${row.track.language}|${row.track.name}`"
                class="flex text-xs gap-2 px-2 py-2.5 m-0 rounded-md items-center border-b border-sky-200 dark:border-sky-400/12 last:border-b-0"
            >
                <span
                    class="shrink-0 rounded-full text-slate-500 dark:text-slate-400 bg-neutral-50 dark:bg-slate-900/45 border border-neutral-200 dark:border-slate-600/55 w-6 h-6 p-0 inline-flex items-center justify-center text-[0.625rem] font-semibold"
                    >{{ i + 1 }}</span
                >
                <div class="w-28 shrink-0">
                    <LanguageSelect
                        v-model="row.language"
                        :aria-label="`Language of ${row.track.name}`"
                    />
                </div>
                <input
                    v-model="row.name"
                    type="text"
                    maxlength="100"
                    class="min-w-0 flex-auto font-[inherit] text-xs text-zinc-900 dark:text-slate-200 bg-white dark:bg-[#0c1222] border border-sky-200 dark:border-sky-400/12 rounded-md outline-none px-2.5 py-1.5 min-h-7 h-7 transition-[border-color] duration-[120ms] focus:border-sky-600 dark:focus:border-sky-400"
                    :aria-label="`Name of ${row.track.name}`"
                />
                <span
                    v-if="row.track.default"
                    class="shrink-0 rounded-full text-slate-500 dark:text-slate-400 bg-neutral-50 dark:bg-slate-900/45 border border-neutral-200 dark:border-slate-600/55 px-2 py-[0.2rem] text-[0.6875rem] font-medium text-center"
                    title="Played when a viewer's language matches no track"
                    >Default</span
                >
            </div>
            <!-- The track being added, in its place in the list, until it is in. -->
            <div
                v-if="adding"
                class="flex text-xs gap-2 px-2 py-2.5 m-0 rounded-md items-center border-b border-sky-200 dark:border-sky-400/12 last:border-b-0 opacity-70"
                data-test="addingAudioTrack"
            >
                <span
                    class="shrink-0 rounded-full text-slate-500 dark:text-slate-400 bg-neutral-50 dark:bg-slate-900/45 border border-neutral-200 dark:border-slate-600/55 w-6 h-6 p-0 inline-flex items-center justify-center text-[0.625rem] font-semibold"
                    >+</span
                >
                <span
                    class="w-28 shrink-0 px-1 font-mono text-slate-500 dark:text-slate-400"
                    >{{ adding.language }}</span
                >
                <span
                    class="min-w-0 flex-auto truncate text-zinc-900 dark:text-slate-200"
                    >{{ adding.name || 'New track' }}</span
                >
                <span
                    class="shrink-0 rounded-full text-slate-500 dark:text-slate-400 bg-neutral-50 dark:bg-slate-900/45 border border-neutral-200 dark:border-slate-600/55 px-2 py-[0.2rem] text-[0.6875rem] font-medium text-center inline-flex items-center gap-1.5"
                >
                    <svg
                        class="h-3 w-3 animate-spin"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="3"
                        stroke-linecap="round"
                        aria-hidden="true"
                    >
                        <path d="M12 3a9 9 0 1 1-9 9" />
                    </svg>
                    {{ addingLabel }}
                </span>
            </div>
        </div>

        <!-- As the chapter list says it has none yet. -->
        <div
            v-else-if="media"
            class="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-8 text-center"
        >
            <div
                class="flex h-11 w-11 items-center justify-center rounded-full border border-neutral-200 bg-neutral-50 text-slate-500 dark:border-slate-600/55 dark:bg-slate-900/45 dark:text-slate-400"
                aria-hidden="true"
            >
                <svg
                    class="h-5 w-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                >
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                </svg>
            </div>
            <p
                class="m-0 text-[0.8125rem] font-semibold text-zinc-900 dark:text-slate-200"
            >
                No separate audio tracks
            </p>
            <p
                class="m-0 text-xs leading-[1.45] text-slate-500 dark:text-slate-400"
            >
                This video carries its sound inside its picture, so its tracks
                cannot be named or added to here.
            </p>
        </div>

        <p
            v-if="!adding && lastAdd?.state === 'failed'"
            class="mt-2 text-xs text-red-600 dark:text-red-400"
            data-test="addAudioTrackFailed"
        >
            The track “{{ lastAdd.name }}” was not added: {{ lastAdd.error }}
        </p>
        <p
            v-else-if="!adding && lastAdd?.state === 'done'"
            class="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
            “{{ lastAdd.name }}” was added.
        </p>
        <p v-if="error" class="mt-2 text-xs text-red-600 dark:text-red-400">
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

        <AddAudioTrackModal
            v-if="media"
            v-model:open="addOpen"
            :session-id="sessionId"
            :session-token="sessionToken"
            :etag="media.etag"
            @started="onAddStarted"
        />
    </div>
</template>
