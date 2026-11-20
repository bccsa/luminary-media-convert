<script setup lang="ts">
/**
 * The camera angles of a post's existing video, opened by an edit session: one
 * row per angle, renamed, given a language and a hearing-impaired kind, and
 * removed, together on save, and a new angle to add from a file. A video with
 * a single picture shows it as one unnamed row; the first angle added names
 * it, and only then are there angles to give a language or a kind.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { LanguageSelect } from '@luminary-media-converter/encode-config';
import { getEncodedMedia, putVideoAngles } from '../../api';
import type {
    AddVideoAngleJob,
    AngleAccessibility,
    EncodedMedia,
    VideoAngle,
    VideoAngleEdit,
} from '../../types';
import FormSelect, { type SelectOption } from '../FormSelect.vue';
import AddVideoAngleModal from './AddVideoAngleModal.vue';
import { isChangedElsewhere, saveErrorMessage } from '../../utils/errors';

const props = defineProps<{
    sessionId: string;
    sessionToken: string | null;
}>();

const emit = defineEmits<{
    /**
     * The master changed — saved here, or moved on to a version another
     * machine wrote: whatever holds the old one should load it again. A save
     * passes on its `published`, whether Luminary CMS has stored it yet.
     */
    saved: [published?: boolean];
}>();

type AngleKind = AngleAccessibility | 'none';

/** One editable row per angle: the angle as read, and what it is being changed to. */
interface AngleRow {
    angle: VideoAngle;
    name: string;
    /** The audio language its picture belongs to; empty for none. */
    language: string;
    accessibility: AngleKind;
    /** Taken out on the next save. */
    removed: boolean;
}

/** The hearing-impaired kinds of view, as the editor names them. */
const ACCESSIBILITY_OPTIONS: SelectOption[] = [
    { value: 'none', label: 'None' },
    { value: 'captions', label: 'Captions' },
    { value: 'sign-language', label: 'Sign language' },
    { value: 'lip-reading', label: 'Lip reading' },
];

const media = ref<EncodedMedia | null>(null);
const rows = ref<AngleRow[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const savedAt = ref<Date | null>(null);

function setRows(next: EncodedMedia): void {
    media.value = next;
    rows.value = (next.angles ?? []).map((angle) => ({
        angle,
        name: angle.name,
        language: angle.language ?? '',
        accessibility: angle.accessibility ?? 'none',
        removed: false,
    }));
}

const shown = computed(() => rows.value.filter((row) => !row.removed));

/** A single picture, not yet an angle: nothing to rename or remove. */
const singlePicture = computed(
    () => rows.value.length === 1 && rows.value[0].angle.id === ''
);

/**
 * One edit per angle changed, carrying only what changed: a field left out
 * stays as it is in the master, so a rename does not rewrite the language a
 * save elsewhere gave it.
 */
const edits = computed<VideoAngleEdit[]>(() =>
    shown.value
        .filter((row) => row.angle.id)
        .map((row) => {
            const edit: VideoAngleEdit = { id: row.angle.id };
            const name = row.name.trim();
            if (name !== row.angle.name) edit.name = name;
            if (row.language !== (row.angle.language ?? '')) {
                edit.language = row.language;
            }
            if (row.accessibility !== (row.angle.accessibility ?? 'none')) {
                edit.accessibility = row.accessibility;
            }
            return edit;
        })
        .filter((edit) => Object.keys(edit).length > 1)
);

const removed = computed(() =>
    rows.value.filter((row) => row.removed).map((row) => row.angle.id)
);

const changeCount = computed(() => edits.value.length + removed.value.length);

/**
 * The angle a viewer starts on, as it will be once saved: the one marked so,
 * or, when that one is being removed, the first left, as the save makes it.
 */
const playsFirst = computed(
    () => shown.value.find((row) => row.angle.default) ?? shown.value[0]
);

/**
 * Some angles have a language and the one that plays first has none: a viewer
 * who moves to another language's picture cannot get back to it by choosing
 * its audio again, since nothing says which audio it goes with.
 */
const playsFirstNeedsLanguage = computed(
    () =>
        !singlePicture.value &&
        !!playsFirst.value &&
        !playsFirst.value.language &&
        shown.value.some((row) => !!row.language)
);

/** The video changed since it was read: saving over it is refused until it is read again. */
const isConflict = computed(() => /changed since/i.test(error.value ?? ''));

/** The angle being added, while it is: renaming waits for it. */
const adding = computed(() =>
    media.value?.addingAngle?.state === 'running'
        ? media.value.addingAngle
        : null
);
/** A track being added holds the master too. */
const busy = computed(
    () => !!adding.value || media.value?.adding?.state === 'running'
);
const lastAdd = computed(() => media.value?.addingAngle);
const addOpen = ref(false);

const PHASES: Record<string, string> = {
    reading: 'Reading the video',
    encoding: 'Encoding',
    uploading: 'Uploading',
    saving: 'Adding it',
};

const addingLabel = computed(() => {
    const job = adding.value;
    if (!job) return '';
    const phase = PHASES[job.phase] ?? job.phase;
    return job.phase === 'encoding' || job.phase === 'uploading'
        ? `${phase} ${job.progress}%`
        : `${phase}…`;
});

/**
 * Read again every second while an angle is being added, until it is done. One
 * read at a time: reading an encrypted master can take longer than the
 * interval, and two reads that both found the add done would reload the player
 * twice.
 */
let poll: ReturnType<typeof setTimeout> | undefined;
let polling = false;
function stopPolling(): void {
    polling = false;
    if (poll) clearTimeout(poll);
    poll = undefined;
}
function startPolling(): void {
    if (polling) return;
    polling = true;
    poll = setTimeout(pollOnce, 1000);
}
async function pollOnce(): Promise<void> {
    poll = undefined;
    const token = props.sessionToken;
    if (token) {
        try {
            const next = await getEncodedMedia(props.sessionId, token);
            if (!polling) return;
            if (next.addingAngle?.state !== 'running') {
                stopPolling();
                setRows(next);
                if (next.addingAngle?.state === 'done') emit('saved');
                return;
            }
            media.value = next;
        } catch {
            // The next read asks again.
        }
    }
    if (polling) poll = setTimeout(pollOnce, 1000);
}
watch(adding, (running) => (running ? startPolling() : undefined));
onBeforeUnmount(stopPolling);

function onAddStarted(job: AddVideoAngleJob): void {
    if (media.value) media.value = { ...media.value, addingAngle: job };
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
    if (!token || !media.value || changeCount.value === 0) return;
    saving.value = true;
    error.value = null;
    try {
        const next = await putVideoAngles(
            props.sessionId,
            token,
            media.value.etag,
            edits.value,
            removed.value
        );
        setRows(next);
        savedAt.value = new Date();
        emit('saved', next.published);
    } catch (err) {
        error.value = saveErrorMessage(err);
        if (isChangedElsewhere(err)) void followNewerVersion();
    } finally {
        saving.value = false;
    }
}

/**
 * Another machine saved the video first, and the session has moved on to its
 * version. The edits here stay, to be saved again over it, so only the version
 * read is replaced — its ETag is what the next save has to name — and the page
 * follows the new master.
 */
async function followNewerVersion(): Promise<void> {
    emit('saved');
    const token = props.sessionToken;
    if (!token) return;
    try {
        media.value = await getEncodedMedia(props.sessionId, token);
    } catch {
        // The old ETag stays; the next save is refused as changed, and offers
        // to read the video again.
    }
}

function discard(): void {
    if (media.value) setRows(media.value);
    error.value = null;
}

/** Read again when the other tab changed the master. */
defineExpose({ load });

watch(() => [props.sessionId, props.sessionToken] as const, load, {
    immediate: true,
});
</script>

<template>
    <!-- The chapter list's card, so the tabs read as one editor. -->
    <div
        class="mt-3.5 flex min-h-0 flex-auto flex-col overflow-hidden rounded-[10px] border border-sky-200 bg-white/96 px-5 pt-2 pb-4 shadow-[0_1px_2px_rgb(9_9_11/0.04),0_0_0_1px_rgb(9_9_11/0.06)] dark:border-sky-400/12 dark:bg-[rgba(30,41,55,0.82)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_8px_30px_rgb(0_0_0/0.25)]"
        data-test="videoAnglesPanel"
    >
        <div
            class="m-0 mb-2.5 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sky-200 pt-0.5 pb-2 dark:border-sky-400/12"
        >
            <div class="flex min-w-0 flex-wrap items-baseline gap-2">
                <h3
                    class="m-0 text-[0.9375rem] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-slate-200"
                >
                    Angles
                </h3>
                <span class="text-xs text-slate-500 dark:text-slate-400">
                    <template v-if="singlePicture">One picture</template>
                    <template v-else-if="shown.length > 0">
                        {{ shown.length }} angle{{
                            shown.length !== 1 ? 's' : ''
                        }}
                    </template>
                    <template v-else-if="media">No picture</template>
                    <template v-if="savedAt && changeCount === 0">
                        · Saved</template
                    >
                </span>
            </div>
            <div class="ml-auto flex items-center gap-1.5">
                <span
                    v-if="changeCount > 0"
                    class="chapter-unsaved-pill"
                    title="Changes stay here until you save them."
                >
                    Unsaved
                </span>
                <button
                    v-if="changeCount > 0"
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
                    :disabled="!media || busy || loading || shown.length === 0"
                    :title="
                        busy
                            ? 'Something is being added to this video'
                            : 'Add an angle from a file or a link'
                    "
                    data-test="showAddVideoAngle"
                    @click="addOpen = true"
                >
                    + Add angle
                </button>
                <button
                    v-if="!singlePicture"
                    type="button"
                    class="chapter-save-btn"
                    :disabled="changeCount === 0 || saving || busy"
                    data-test="saveVideoAngles"
                    @click="save"
                >
                    {{ saving ? 'Saving…' : 'Save angles' }}
                </button>
            </div>
        </div>

        <p v-if="loading" class="px-2 text-xs text-slate-500">
            Reading the video…
        </p>

        <div
            v-else-if="shown.length > 0 || adding"
            class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        >
            <!--
                A row wraps when the panel is narrow (the splitter goes down to
                a few hundred pixels): the name keeps a readable width, the two
                selects drop under it, and the "Plays first" pill, sizes and
                remove stay on the name's line, moving to a line of their own
                only when the name and selects have no room beside them.
            -->
            <div
                v-for="(row, i) in shown"
                :key="row.angle.id || 'single'"
                class="flex flex-wrap text-xs gap-2 px-2 py-2.5 m-0 rounded-md items-start border-b border-sky-200 dark:border-sky-400/12 last:border-b-0"
                data-test="videoAngleRow"
            >
                <span
                    class="shrink-0 mt-0.5 rounded-full text-slate-500 dark:text-slate-400 bg-neutral-50 dark:bg-slate-900/45 border border-neutral-200 dark:border-slate-600/55 w-6 h-6 p-0 inline-flex items-center justify-center text-[0.625rem] font-semibold"
                    >{{ i + 1 }}</span
                >
                <span
                    v-if="singlePicture"
                    class="min-w-36 grow basis-0 self-center text-slate-600 dark:text-slate-300"
                >
                    This video's picture
                    <span class="text-slate-500 dark:text-slate-400"
                        >· named when an angle is added</span
                    >
                </span>
                <!-- Never narrower than the two selects side by side (4.75rem + gap + 9rem). -->
                <div
                    v-else
                    class="flex min-w-57 grow basis-0 flex-wrap items-center gap-2"
                >
                    <input
                        v-model="row.name"
                        type="text"
                        maxlength="100"
                        class="min-w-36 grow basis-36 font-[inherit] text-xs text-zinc-900 dark:text-slate-200 bg-white dark:bg-[#0c1222] border border-sky-200 dark:border-sky-400/12 rounded-md outline-none px-2.5 py-1.5 min-h-7 h-7 transition-[border-color] duration-[120ms] focus:border-sky-600 dark:focus:border-sky-400"
                        :aria-label="`Name of ${row.angle.name}`"
                    />
                    <!-- A single picture is not an angle yet: nothing for a player to follow. -->
                    <div class="flex flex-wrap items-center gap-2">
                        <div
                            class="shrink-0"
                            title="The audio language this picture belongs to, such as burnt-in titles. A viewer who picks that audio is shown it."
                        >
                            <LanguageSelect
                                v-model="row.language"
                                placeholder="none"
                                :aria-label="`Language of ${row.angle.name}`"
                                data-test="videoAngleLanguage"
                            />
                        </div>
                        <!-- As tall as the name beside it. -->
                        <div
                            class="w-36 shrink-0"
                            title="A view for deaf or hard-of-hearing viewers. They stay on this kind of view when they change the audio language."
                        >
                            <FormSelect
                                :model-value="row.accessibility"
                                :options="ACCESSIBILITY_OPTIONS"
                                variant="field"
                                size="sm"
                                presentation="custom"
                                select-class="min-h-7! py-[0.3125rem]!"
                                :aria-label="`Accessibility of ${row.angle.name}`"
                                data-test="videoAngleAccessibility"
                                @update:model-value="
                                    row.accessibility = $event as AngleKind
                                "
                            />
                        </div>
                    </div>
                </div>
                <div class="ml-auto flex h-7 shrink-0 items-center gap-2">
                    <span
                        v-if="row.angle.default"
                        class="shrink-0 rounded-full text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-400/10 border border-sky-200 dark:border-sky-400/25 px-2 py-[0.2rem] text-[0.6875rem] font-medium"
                        title="The angle a viewer sees first"
                        >Plays first</span
                    >
                    <span
                        class="shrink-0 text-[0.6875rem] text-slate-500 dark:text-slate-400"
                        >{{ row.angle.renditions }} size{{
                            row.angle.renditions === 1 ? '' : 's'
                        }}</span
                    >
                    <!-- A video keeps one angle at least. -->
                    <button
                        v-if="!singlePicture"
                        type="button"
                        class="appearance-none inline-flex items-center justify-center min-w-7 min-h-7 shrink-0 rounded-md border-0 bg-transparent p-0 text-slate-500 dark:text-slate-400 cursor-pointer transition-colors duration-[120ms] hover:text-red-600 hover:bg-red-500/10 dark:hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-500"
                        :disabled="shown.length <= 1 || saving || busy"
                        :title="
                            shown.length <= 1
                                ? 'A video keeps at least one angle'
                                : `Remove ${row.angle.name}`
                        "
                        :aria-label="`Remove ${row.angle.name}`"
                        data-test="removeVideoAngle"
                        @click="row.removed = true"
                    >
                        <svg
                            class="h-4 w-4"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            aria-hidden="true"
                        >
                            <path d="M8 8l8 8M16 8l-8 8" />
                        </svg>
                    </button>
                </div>
            </div>
            <!-- The angle being added, in its place in the list, until it is in. -->
            <div
                v-if="adding"
                class="flex text-xs gap-2 px-2 py-2.5 m-0 rounded-md items-center border-b border-sky-200 dark:border-sky-400/12 last:border-b-0 opacity-70"
                data-test="addingVideoAngle"
            >
                <span
                    class="shrink-0 rounded-full text-slate-500 dark:text-slate-400 bg-neutral-50 dark:bg-slate-900/45 border border-neutral-200 dark:border-slate-600/55 w-6 h-6 p-0 inline-flex items-center justify-center text-[0.625rem] font-semibold"
                    >+</span
                >
                <span
                    class="min-w-0 flex-auto truncate text-zinc-900 dark:text-slate-200"
                    >{{ adding.name || 'New angle' }}</span
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

        <!-- An audio-only video: no picture to add an angle beside. -->
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
                    <path d="m16 10 5-3v10l-5-3" />
                    <rect x="3" y="6" width="13" height="12" rx="2" />
                </svg>
            </div>
            <p
                class="m-0 text-[0.8125rem] font-semibold text-zinc-900 dark:text-slate-200"
            >
                No picture
            </p>
            <p
                class="m-0 text-xs leading-[1.45] text-slate-500 dark:text-slate-400"
            >
                This is an audio-only video, so it has no angles to add to.
            </p>
        </div>

        <p
            v-if="!loading && playsFirstNeedsLanguage"
            class="mt-2 text-xs text-amber-700 dark:text-amber-400"
            data-test="videoAngleLanguageHint"
        >
            Give the angle that plays first a language too. Otherwise choosing
            its audio again will not bring its picture back.
        </p>
        <p
            v-if="!adding && lastAdd?.state === 'failed'"
            class="mt-2 text-xs text-red-600 dark:text-red-400"
            data-test="addVideoAngleFailed"
        >
            The angle “{{ lastAdd.name }}” was not added: {{ lastAdd.error }}
        </p>
        <p
            v-else-if="!adding && lastAdd?.state === 'done'"
            class="mt-2 text-xs text-slate-500 dark:text-slate-400"
        >
            “{{ lastAdd.name }}” was added. Pick it under the player with Angle.
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

        <AddVideoAngleModal
            v-if="media"
            v-model:open="addOpen"
            :session-id="sessionId"
            :session-token="sessionToken"
            :etag="media.etag"
            :names-main="singlePicture"
            @started="onAddStarted"
        />
    </div>
</template>
