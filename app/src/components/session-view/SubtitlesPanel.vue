<script setup lang="ts">
/**
 * The subtitles of a post's existing video, opened by an edit session: one
 * language at a time, edited on a timeline as chapters are, or beside an
 * original language to translate it. A language comes from nothing, from an
 * `.srt` or `.vtt` file, or from another language's timings, and goes out as
 * either file. Each language saves on its own, into the video's master, so
 * every player shows it; edits not yet saved stay here when the language or
 * the tab changes.
 */
import { computed, reactive, ref, watch } from 'vue';
import {
    deleteSubtitles,
    getEncodedMedia,
    getSubtitles,
    putSubtitles,
} from '../../api';
import type { EncodedMedia } from '../../types';
import { SegmentEditor, type Segment } from '../segment-editor';
import SubtitleCompare from './SubtitleCompare.vue';
import {
    copyTimings,
    languageName,
    readSubtitleFile,
    subtitlesToSrt,
    subtitlesToVtt,
} from './subtitles';

const props = defineProps<{
    sessionId: string;
    sessionToken: string | null;
    /** The video's length, for the timeline. */
    duration: number;
    getCurrentTime: () => number;
    onSeek?: (seconds: number) => void;
    onPlayPause?: () => void;
    isPlaying?: boolean;
    fps?: number;
}>();

const emit = defineEmits<{
    /** The master changed: whatever holds the old one should load it again. */
    saved: [];
}>();

/** One language as edited here, against what was last read or saved. */
interface Draft {
    name: string;
    segments: Segment[];
    /** The VTT and name as stored; a draft that differs is unsaved. */
    savedVtt: string;
    savedName: string;
    /** Not in the video yet: only here until the first save. */
    isNew: boolean;
    loaded: boolean;
}

const media = ref<EncodedMedia | null>(null);
const drafts = reactive<Record<string, Draft>>({});
const selected = ref<string | null>(null);
const view = ref<'edit' | 'compare'>('edit');
const compareWith = ref<string | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/** Stored languages first, as the master lists them, then the ones added here. */
const languages = computed(() => {
    const stored = (media.value?.subtitles ?? []).map((t) => t.language);
    const added = Object.keys(drafts).filter((l) => drafts[l]!.isNew && !stored.includes(l));
    return [...stored, ...added];
});

const draft = computed(() => (selected.value ? drafts[selected.value] : undefined));

const isDirty = (d: Draft | undefined) =>
    !!d && d.loaded && (d.isNew || subtitlesToVtt(d.segments) !== d.savedVtt || d.name.trim() !== d.savedName);

const unsavedCount = computed(() => languages.value.filter((l) => isDirty(drafts[l])).length);

/** Something is being added to the master: a save would be refused. */
const busy = computed(
    () => media.value?.adding?.state === 'running' || media.value?.addingAngle?.state === 'running'
);

/** The video changed since it was read: saving over it is refused until it is read again. */
const isConflict = computed(() => /changed since/i.test(error.value ?? ''));

async function load(): Promise<void> {
    const token = props.sessionToken;
    if (!token) return;
    loading.value = true;
    error.value = null;
    try {
        media.value = await getEncodedMedia(props.sessionId, token);
        for (const track of media.value.subtitles ?? []) {
            const kept = drafts[track.language];
            // Unsaved words survive a reread; a stored language read again shows what is stored now.
            if (kept && isDirty(kept)) {
                kept.isNew = false;
                continue;
            }
            drafts[track.language] = {
                name: track.name,
                segments: [],
                savedVtt: '',
                savedName: track.name,
                isNew: false,
                loaded: false,
            };
        }
        if (!selected.value || !languages.value.includes(selected.value)) {
            selected.value = languages.value[0] ?? null;
        }
        if (selected.value) await ensureLoaded(selected.value);
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        loading.value = false;
    }
}

/** A stored language's words, read once; until then its draft is empty and not unsaved. */
async function ensureLoaded(language: string): Promise<void> {
    const d = drafts[language];
    const token = props.sessionToken;
    if (!d || d.loaded || d.isNew || !token) return;
    const { vtt, name } = await getSubtitles(props.sessionId, token, language);
    const segments = readSubtitleFile(vtt);
    Object.assign(d, { segments, savedVtt: subtitlesToVtt(segments), savedName: name, name, loaded: true });
}

async function select(language: string): Promise<void> {
    selected.value = language;
    error.value = null;
    notice.value = null;
    try {
        await ensureLoaded(language);
        if (compareWith.value) await ensureLoaded(compareWith.value);
    } catch (err) {
        error.value = (err as Error).message;
    }
}

/** The languages to compare the selected one with: every other one that has words. */
const compareOptions = computed(() => languages.value.filter((l) => l !== selected.value));

watch(compareOptions, (options) => {
    if (!compareWith.value || !options.includes(compareWith.value)) compareWith.value = options[0] ?? null;
});

watch(compareWith, async (language) => {
    if (!language) return;
    try {
        await ensureLoaded(language);
    } catch (err) {
        error.value = (err as Error).message;
    }
});

// ---- Adding a language ------------------------------------------------------

const adding = ref(false);
const newCode = ref('');
const newName = ref('');
const newStart = ref<'empty' | 'file' | 'copy'>('empty');
const newCopyFrom = ref<string | null>(null);
const newFile = ref<{ fileName: string; segments: Segment[] } | null>(null);

const CODE = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;

watch(newCode, (code, before) => {
    // The name follows the code until it is typed over.
    if (!newName.value || newName.value === languageName(before ?? '')) {
        newName.value = CODE.test(code.trim()) ? languageName(code.trim()) : '';
    }
});

const newError = computed(() => {
    const code = newCode.value.trim();
    if (!code) return null;
    if (!CODE.test(code)) return 'A language code: two or three letters, e.g. fr, or pt-BR';
    if (languages.value.includes(code)) return 'This video already has subtitles in that language';
    return null;
});

const canAdd = computed(
    () =>
        !!newCode.value.trim() &&
        !newError.value &&
        !!newName.value.trim() &&
        (newStart.value !== 'file' || !!newFile.value) &&
        (newStart.value !== 'copy' || !!newCopyFrom.value)
);

function openAdd(): void {
    newCode.value = '';
    newName.value = '';
    newStart.value = 'empty';
    newCopyFrom.value = selected.value;
    newFile.value = null;
    adding.value = true;
}

async function pickNewFile(event: Event): Promise<void> {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    newFile.value = { fileName: file.name, segments: readSubtitleFile(await file.text()) };
}

async function addLanguage(): Promise<void> {
    if (!canAdd.value) return;
    const code = newCode.value.trim();
    let segments: Segment[] = [];
    try {
        if (newStart.value === 'file') segments = newFile.value!.segments;
        if (newStart.value === 'copy') {
            await ensureLoaded(newCopyFrom.value!);
            segments = copyTimings(drafts[newCopyFrom.value!]!.segments);
        }
    } catch (err) {
        error.value = (err as Error).message;
        return;
    }
    drafts[code] = {
        name: newName.value.trim(),
        segments,
        savedVtt: '',
        savedName: '',
        isNew: true,
        loaded: true,
    };
    const from = newStart.value === 'copy' ? newCopyFrom.value : null;
    adding.value = false;
    await select(code);
    // Started from another language's timings: translating is the next thing to do.
    if (from) {
        compareWith.value = from;
        view.value = 'compare';
    }
}

// ---- Files ----------------------------------------------------------------

const importInput = ref<HTMLInputElement | null>(null);

async function importInto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    const d = draft.value;
    if (!file || !d) return;
    const segments = readSubtitleFile(await file.text());
    if (segments.length === 0) {
        error.value = `${file.name} has no subtitle lines in it`;
        return;
    }
    d.segments = segments;
    notice.value = `${segments.length} lines from ${file.name}, not saved yet`;
}

function download(kind: 'srt' | 'vtt'): void {
    const d = draft.value;
    if (!d || !selected.value) return;
    const text = kind === 'srt' ? subtitlesToSrt(d.segments) : subtitlesToVtt(d.segments);
    const url = URL.createObjectURL(new Blob([text], { type: kind === 'srt' ? 'application/x-subrip' : 'text/vtt' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selected.value}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- Saving ---------------------------------------------------------------

async function save(): Promise<void> {
    const token = props.sessionToken;
    const d = draft.value;
    const language = selected.value;
    if (!token || !d || !language || !media.value || !isDirty(d)) return;
    saving.value = true;
    error.value = null;
    notice.value = null;
    try {
        const vtt = subtitlesToVtt(d.segments);
        media.value = await putSubtitles(props.sessionId, token, language, media.value.etag, d.name.trim(), vtt);
        Object.assign(d, { savedVtt: vtt, savedName: d.name.trim(), isNew: false });
        notice.value = 'Saved: every player shows these subtitles now';
        emit('saved');
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        saving.value = false;
    }
}

function discard(): void {
    const d = draft.value;
    const language = selected.value;
    if (!d || !language) return;
    error.value = null;
    notice.value = null;
    if (d.isNew) {
        delete drafts[language];
        selected.value = languages.value[0] ?? null;
        return;
    }
    d.segments = readSubtitleFile(d.savedVtt);
    d.name = d.savedName;
}

async function remove(): Promise<void> {
    const token = props.sessionToken;
    const language = selected.value;
    const d = draft.value;
    if (!token || !language || !d || !media.value) return;
    if (d.isNew) return discard();
    if (!window.confirm(`Take the ${d.savedName} subtitles out of this video?`)) return;
    saving.value = true;
    error.value = null;
    try {
        media.value = await deleteSubtitles(props.sessionId, token, language, media.value.etag);
        delete drafts[language];
        selected.value = languages.value[0] ?? null;
        if (selected.value) await ensureLoaded(selected.value);
        emit('saved');
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        saving.value = false;
    }
}

/** Read again when another tab changed the master. */
defineExpose({ load });

watch(() => [props.sessionId, props.sessionToken] as const, load, { immediate: true });

const labelOf = (language: string) => drafts[language]?.name || languageName(language);
</script>

<template>
    <div
        class="mt-3.5 flex min-h-0 flex-auto flex-col overflow-hidden rounded-[10px] border border-sky-200 bg-white/96 px-5 pt-2 pb-4 shadow-[0_1px_2px_rgb(9_9_11/0.04),0_0_0_1px_rgb(9_9_11/0.06)] dark:border-sky-400/12 dark:bg-[rgba(30,41,55,0.82)] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.06),0_8px_30px_rgb(0_0_0/0.25)]"
        data-test="subtitlesPanel"
    >
        <div
            class="m-0 mb-2.5 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-sky-200 pt-0.5 pb-2 dark:border-sky-400/12"
        >
            <div class="flex min-w-0 flex-wrap items-baseline gap-2">
                <h3 class="m-0 text-[0.9375rem] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-slate-200">
                    Subtitles
                </h3>
                <span class="text-xs text-slate-500 dark:text-slate-400">
                    <template v-if="languages.length === 0">None yet</template>
                    <template v-else>{{ languages.length }} language{{ languages.length !== 1 ? 's' : '' }}</template>
                </span>
            </div>
            <div class="ml-auto flex items-center gap-1.5">
                <span v-if="isDirty(draft)" class="chapter-unsaved-pill" title="Changes stay here until you save them.">
                    Unsaved
                </span>
                <button
                    v-if="isDirty(draft)"
                    type="button"
                    class="chapter-toolbar-muted"
                    :disabled="saving"
                    data-test="discardSubtitles"
                    @click="discard"
                >
                    Discard
                </button>
                <button
                    type="button"
                    class="chapter-toolbar-muted"
                    :disabled="!media || loading"
                    data-test="showAddSubtitles"
                    @click="openAdd"
                >
                    + Add language
                </button>
                <button
                    v-if="draft"
                    type="button"
                    class="chapter-save-btn"
                    :disabled="!isDirty(draft) || saving || busy || !draft.name.trim()"
                    :title="busy ? 'Something is being added to this video' : undefined"
                    data-test="saveSubtitles"
                    @click="save"
                >
                    {{ saving ? 'Saving…' : 'Save subtitles' }}
                </button>
            </div>
        </div>

        <div v-if="languages.length > 0" class="mb-2 flex shrink-0 flex-wrap gap-1.5" role="tablist" aria-label="Languages">
            <button
                v-for="language in languages"
                :key="language"
                type="button"
                role="tab"
                :aria-selected="language === selected"
                class="rounded-full border px-3 py-1 text-xs font-medium transition-colors"
                :class="
                    language === selected
                        ? 'border-sky-600 bg-sky-600 text-white dark:border-sky-400 dark:bg-sky-500'
                        : 'border-sky-200 text-slate-600 hover:bg-sky-50 dark:border-sky-400/12 dark:text-slate-300 dark:hover:bg-sky-400/10'
                "
                data-test="subtitleLanguage"
                @click="select(language)"
            >
                {{ labelOf(language) }}<span class="opacity-70"> · {{ language }}</span
                ><span v-if="isDirty(drafts[language])" class="ml-1" aria-label="unsaved">•</span>
            </button>
        </div>

        <template v-if="draft">
            <div class="mb-2 flex shrink-0 flex-wrap items-center gap-2">
                <label class="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
                    Name
                    <input
                        v-model="draft.name"
                        type="text"
                        maxlength="100"
                        class="w-36 rounded-md border border-sky-200 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                        data-test="subtitleName"
                    />
                </label>
                <div class="flex rounded-md border border-sky-200 p-0.5 text-xs dark:border-sky-400/12" role="group" aria-label="View">
                    <button
                        type="button"
                        class="rounded px-2 py-0.5"
                        :class="view === 'edit' ? 'bg-sky-100 font-semibold dark:bg-sky-400/15' : ''"
                        :aria-pressed="view === 'edit'"
                        data-test="subtitleViewEdit"
                        @click="view = 'edit'"
                    >
                        Edit
                    </button>
                    <button
                        type="button"
                        class="rounded px-2 py-0.5 disabled:opacity-50"
                        :class="view === 'compare' ? 'bg-sky-100 font-semibold dark:bg-sky-400/15' : ''"
                        :aria-pressed="view === 'compare'"
                        :disabled="compareOptions.length === 0"
                        :title="compareOptions.length === 0 ? 'Add another language to compare with' : undefined"
                        data-test="subtitleViewCompare"
                        @click="view = 'compare'"
                    >
                        Compare
                    </button>
                </div>
                <label
                    v-if="view === 'compare' && compareOptions.length > 0"
                    class="flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400"
                >
                    with
                    <select
                        v-model="compareWith"
                        class="rounded-md border border-sky-200 bg-white px-1.5 py-1 text-sm dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200"
                        data-test="subtitleCompareWith"
                    >
                        <option v-for="language in compareOptions" :key="language" :value="language">
                            {{ labelOf(language) }}
                        </option>
                    </select>
                </label>
                <div class="ml-auto flex items-center gap-1.5">
                    <button type="button" class="chapter-toolbar-muted" data-test="importSubtitles" @click="importInput?.click()">
                        Import…
                    </button>
                    <input
                        ref="importInput"
                        type="file"
                        accept=".srt,.vtt,text/vtt,application/x-subrip"
                        class="hidden"
                        data-test="importSubtitlesFile"
                        @change="importInto"
                    />
                    <button
                        type="button"
                        class="chapter-toolbar-muted"
                        :disabled="draft.segments.length === 0"
                        data-test="exportSrt"
                        @click="download('srt')"
                    >
                        .srt
                    </button>
                    <button
                        type="button"
                        class="chapter-toolbar-muted"
                        :disabled="draft.segments.length === 0"
                        data-test="exportVtt"
                        @click="download('vtt')"
                    >
                        .vtt
                    </button>
                    <button
                        type="button"
                        class="chapter-toolbar-muted text-red-600 dark:text-red-400"
                        :disabled="saving || busy"
                        data-test="removeSubtitles"
                        @click="remove"
                    >
                        Remove
                    </button>
                </div>
            </div>

            <p v-if="error" class="mb-2 shrink-0 text-sm text-red-600 dark:text-red-400" data-test="subtitlesError">
                {{ error }}
                <button v-if="isConflict" type="button" class="chapter-toolbar-muted ml-1" @click="load">
                    Read it again
                </button>
            </p>
            <p v-else-if="notice" class="mb-2 shrink-0 text-xs text-slate-500 dark:text-slate-400" data-test="subtitlesNotice">
                {{ notice }}
            </p>

            <SubtitleCompare
                v-if="view === 'compare' && compareWith && drafts[compareWith]"
                v-model="draft.segments"
                :original="drafts[compareWith]!.segments"
                :original-name="labelOf(compareWith)"
                :translation-name="labelOf(selected!)"
                :on-seek="onSeek"
            />
            <SegmentEditor
                v-else
                v-model="draft.segments"
                class="min-h-0 flex-1 overflow-hidden"
                mode="subtitles"
                embedded
                :duration="duration"
                :get-current-time="getCurrentTime"
                :on-seek="onSeek"
                :on-play-pause="onPlayPause"
                :is-playing="isPlaying"
                :show-help="false"
                title="Lines"
                empty-title="No lines yet"
                empty-hint="Mark a line's in and out on the timeline, or import an .srt or .vtt file."
                keyboard-scope="focus"
                :fps="fps"
            />
        </template>

        <div v-else-if="!loading && media" class="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <p class="m-0 text-sm text-slate-600 dark:text-slate-300">This video has no subtitles yet.</p>
            <p class="m-0 max-w-sm text-xs text-slate-500 dark:text-slate-400">
                Add a language, from an .srt or .vtt file or from nothing. Once saved, every player offers it.
            </p>
        </div>
        <p v-if="!draft && error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

        <div
            v-if="adding"
            class="fixed inset-0 z-100 flex items-center justify-center p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="add-subtitles-title"
        >
            <button type="button" class="absolute inset-0 bg-slate-900/50 dark:bg-black/60" aria-label="Close" @click="adding = false" />
            <form
                class="relative flex w-full max-w-md flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-700 dark:bg-slate-800"
                data-test="addSubtitlesForm"
                @submit.prevent="addLanguage"
            >
                <h2 id="add-subtitles-title" class="m-0 text-lg font-semibold text-slate-900 dark:text-slate-100">
                    Add subtitles in a language
                </h2>
                <div class="grid grid-cols-[7rem_1fr] gap-3">
                    <label class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                        Code
                        <input
                            v-model="newCode"
                            type="text"
                            placeholder="fr"
                            class="rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200"
                            data-test="newSubtitleCode"
                        />
                    </label>
                    <label class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                        Name players show
                        <input
                            v-model="newName"
                            type="text"
                            maxlength="100"
                            placeholder="Français"
                            class="rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200"
                            data-test="newSubtitleName"
                        />
                    </label>
                </div>
                <p v-if="newError" class="m-0 -mt-1 text-xs text-red-600 dark:text-red-400">{{ newError }}</p>
                <fieldset class="m-0 flex flex-col gap-1.5 border-0 p-0 text-sm text-slate-700 dark:text-slate-300">
                    <legend class="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">Start from</legend>
                    <label class="flex items-center gap-2"><input v-model="newStart" type="radio" value="empty" /> Nothing</label>
                    <label class="flex items-center gap-2">
                        <input v-model="newStart" type="radio" value="file" data-test="newSubtitleFromFile" /> An .srt or .vtt file
                    </label>
                    <input
                        v-if="newStart === 'file'"
                        type="file"
                        accept=".srt,.vtt,text/vtt,application/x-subrip"
                        class="ml-6 text-xs"
                        data-test="newSubtitleFile"
                        @change="pickNewFile"
                    />
                    <p v-if="newStart === 'file' && newFile" class="m-0 ml-6 text-xs text-slate-500">
                        {{ newFile.segments.length }} lines in {{ newFile.fileName }}
                    </p>
                    <label v-if="languages.length > 0" class="flex items-center gap-2">
                        <input v-model="newStart" type="radio" value="copy" data-test="newSubtitleFromCopy" />
                        The timings of
                        <select
                            v-model="newCopyFrom"
                            class="rounded-md border border-sky-200 bg-white px-1.5 py-0.5 text-sm dark:border-sky-400/12 dark:bg-[#0c1222]"
                            @focus="newStart = 'copy'"
                        >
                            <option v-for="language in languages" :key="language" :value="language">{{ labelOf(language) }}</option>
                        </select>
                        , to translate
                    </label>
                </fieldset>
                <div class="flex justify-end gap-2">
                    <button
                        type="button"
                        class="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                        @click="adding = false"
                    >
                        Cancel
                    </button>
                    <button
                        type="submit"
                        class="rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
                        :disabled="!canAdd"
                        data-test="addSubtitles"
                    >
                        Add
                    </button>
                </div>
                <p class="m-0 text-xs text-slate-500 dark:text-slate-400">It goes into the video when you save it.</p>
            </form>
        </div>
    </div>
</template>
