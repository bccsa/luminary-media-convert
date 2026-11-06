<script setup lang="ts">
/**
 * The subtitles of a post's existing video, opened by an edit session. One
 * language is worked on at a time, chosen once for both views: Lines edits
 * what it says and when, Translate sets it beside another language to
 * translate. A language comes from nothing, an `.srt` or `.vtt` file, or
 * another's timings, goes out as either file, and saves on its own into the
 * video's master, so every player shows it. Edits not yet saved stay when the
 * language, the view or the tab changes.
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { deleteSubtitles, getEncodedMedia, getSubtitles, putSubtitles } from '../../api';
import type { EncodedMedia } from '../../types';
import type { Segment } from '../segment-editor';
import SubtitleCompare from './SubtitleCompare.vue';
import SubtitleLines from './SubtitleLines.vue';
import { copyTimings, languageName, readSubtitleFile, subtitlesToSrt, subtitlesToVtt } from './subtitles';

const props = defineProps<{
    sessionId: string;
    sessionToken: string | null;
    /** The video's length, for the strip of lines. */
    duration: number;
    getCurrentTime: () => number;
    onSeek?: (seconds: number) => void;
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
const view = ref<'lines' | 'translate'>('lines');
const original = ref<string | null>(null);
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

/** The line open in the list, shared with the timeline's subtitle track. */
const selectedLine = ref<string | null>(null);

/** The open language's lines, for the timeline's subtitle track; null until they are read. */
const timelineLines = computed<Segment[] | null>({
    get: () => (draft.value?.loaded ? draft.value.segments : null),
    set: (next) => {
        if (draft.value && next) draft.value.segments = next;
    },
});

const isDirty = (d: Draft | undefined) =>
    !!d && d.loaded && (d.isNew || subtitlesToVtt(d.segments) !== d.savedVtt || d.name.trim() !== d.savedName);

/** Something is being added to the master: a save would be refused. */
const busy = computed(
    () => media.value?.adding?.state === 'running' || media.value?.addingAngle?.state === 'running'
);

/** The video changed since it was read: saving over it is refused until it is read again. */
const isConflict = computed(() => /changed since/i.test(error.value ?? ''));

const labelOf = (language: string) => drafts[language]?.name.trim() || languageName(language);

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
    selectedLine.value = null;
    error.value = null;
    notice.value = null;
    optionsOpen.value = false;
    try {
        await ensureLoaded(language);
    } catch (err) {
        error.value = (err as Error).message;
    }
}

/** What Translate can set the language beside: every other one. */
const originals = computed(() => languages.value.filter((l) => l !== selected.value));

watch(originals, (options) => {
    if (!original.value || !options.includes(original.value)) original.value = options[0] ?? null;
});

watch([original, view], async ([language, v]) => {
    if (!language || v !== 'translate') return;
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
const SUGGESTED = ['en', 'fr', 'pt', 'es', 'de', 'nl', 'af', 'zu', 'xh', 'st', 'tn', 'sw', 'ln', 'rw', 'am', 'ar', 'zh', 'ja', 'ko', 'ru'];

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

/** A file's language when its name ends in one, as `talk-fr.srt` or `fr.vtt` do. */
function codeFromFileName(fileName: string): string {
    const match = /(?:^|[-_.])([a-z]{2,3}(?:-[A-Z]{2})?)\.(?:srt|vtt)$/i.exec(fileName);
    return match ? match[1]!.toLowerCase() : '';
}

function openAdd(preset: { copyFrom?: string; file?: { fileName: string; segments: Segment[] } } = {}): void {
    newCode.value = preset.file ? codeFromFileName(preset.file.fileName) : '';
    newName.value = newCode.value ? languageName(newCode.value) : '';
    newFile.value = preset.file ?? null;
    newCopyFrom.value = preset.copyFrom ?? selected.value;
    newStart.value = preset.file ? 'file' : preset.copyFrom ? 'copy' : 'empty';
    optionsOpen.value = false;
    adding.value = true;
}

async function readFile(file: File): Promise<{ fileName: string; segments: Segment[] }> {
    return { fileName: file.name, segments: readSubtitleFile(await file.text()) };
}

const newFileInput = ref<HTMLInputElement | null>(null);

/** The file button chooses this way of starting, then opens the picker. */
function chooseNewFile(): void {
    newStart.value = 'file';
    newFileInput.value?.click();
}

async function pickNewFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) newFile.value = await readFile(file);
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
    drafts[code] = { name: newName.value.trim(), segments, savedVtt: '', savedName: '', isNew: true, loaded: true };
    const from = newStart.value === 'copy' ? newCopyFrom.value : null;
    adding.value = false;
    await select(code);
    // Started from another language's timings: translating is the next thing to do.
    view.value = from ? 'translate' : 'lines';
    if (from) original.value = from;
}

// ---- Options menu ---------------------------------------------------------

const optionsOpen = ref(false);
const optionsRef = ref<HTMLElement | null>(null);
const importInput = ref<HTMLInputElement | null>(null);

function onDocumentMouseDown(event: MouseEvent): void {
    if (!optionsRef.value?.contains(event.target as Node)) optionsOpen.value = false;
}

watch(optionsOpen, (open) => {
    if (open) document.addEventListener('mousedown', onDocumentMouseDown, true);
    else document.removeEventListener('mousedown', onDocumentMouseDown, true);
});
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocumentMouseDown, true));

async function importInto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    optionsOpen.value = false;
    const d = draft.value;
    if (!file || !d) return;
    const { segments } = await readFile(file);
    if (segments.length === 0) {
        error.value = `${file.name} has no subtitle lines in it`;
        return;
    }
    d.segments = segments;
    notice.value = `${segments.length} lines from ${file.name}, not saved yet`;
}

function download(kind: 'srt' | 'vtt'): void {
    optionsOpen.value = false;
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

/** A file dropped on the panel: into a new language, or the one open when it has no lines yet. */
const dropping = ref(false);
async function onDrop(event: DragEvent): Promise<void> {
    dropping.value = false;
    const file = [...(event.dataTransfer?.files ?? [])].find((f) => /\.(srt|vtt)$/i.test(f.name));
    if (!file) return;
    const read = await readFile(file);
    // Into the open add form, keeping what was typed there.
    if (adding.value) {
        newFile.value = read;
        newStart.value = 'file';
        if (!newCode.value) {
            newCode.value = codeFromFileName(read.fileName);
            newName.value = newCode.value ? languageName(newCode.value) : newName.value;
        }
        return;
    }
    if (draft.value && draft.value.segments.length === 0) {
        draft.value.segments = read.segments;
        notice.value = `${read.segments.length} lines from ${file.name}, not saved yet`;
        return;
    }
    openAdd({ file: read });
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
        notice.value = `Saved: every player offers ${labelOf(language)} now`;
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
    optionsOpen.value = false;
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
defineExpose({
    load,
    /** The open language's name, for the timeline's subtitle track. */
    timelineName: computed(() => (selected.value ? labelOf(selected.value) : '')),
    timelineLines,
    selectedLine,
});

watch(() => [props.sessionId, props.sessionToken] as const, load, { immediate: true });

const input =
    'rounded-lg border border-sky-200 bg-white px-2.5 text-sm text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400';
const viewTab =
    'flex h-10 items-center justify-center gap-2 rounded-lg text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const onTab = 'bg-white font-semibold text-zinc-900 shadow-sm dark:bg-slate-700 dark:text-slate-100';
const offTab = 'font-medium text-slate-600 hover:text-zinc-900 dark:text-slate-400 dark:hover:text-slate-200';
</script>

<template>
    <section
        class="relative mt-3.5 flex min-h-0 flex-auto flex-col overflow-hidden rounded-[14px] border border-sky-200 bg-white shadow-[0_1px_2px_rgb(9_9_11/0.04)] dark:border-sky-400/12 dark:bg-[rgba(30,41,55,0.82)]"
        aria-label="Subtitles"
        data-test="subtitlesPanel"
        @dragover.prevent="dropping = true"
        @dragleave.self="dropping = false"
        @drop.prevent="onDrop"
    >
        <div class="flex shrink-0 items-center gap-2.5 border-b border-sky-100 px-5 py-4 dark:border-sky-400/10">
            <h3 class="m-0 text-base font-semibold text-zinc-900 dark:text-slate-100">Subtitles</h3>
            <span class="text-[13px] text-slate-500 dark:text-slate-400">
                <template v-if="languages.length === 0">None yet</template>
                <template v-else>{{ languages.length }} language{{ languages.length !== 1 ? 's' : '' }}</template>
            </span>
            <template v-if="draft">
                <span
                    v-if="isDirty(draft)"
                    class="ml-auto rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-400/15 dark:text-amber-300"
                    title="Changes stay here until you save them."
                    >Unsaved</span
                >
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
                    class="chapter-save-btn"
                    :class="{ 'ml-auto': !isDirty(draft) }"
                    :disabled="!isDirty(draft) || saving || busy || !draft.name.trim()"
                    :title="busy ? 'Something is being added to this video' : undefined"
                    data-test="saveSubtitles"
                    @click="save"
                >
                    {{ saving ? 'Saving…' : `Save ${labelOf(selected!)}` }}
                </button>
            </template>
        </div>

        <!-- As on Chapters, Audio tracks and Angles: the header stays, everything under it scrolls. -->
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto" data-test="subtitlesBody">
            <template v-if="draft">
                <div
                    role="tablist"
                    aria-label="Subtitles view"
                    class="mx-5 mt-3.5 grid shrink-0 grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-slate-800/60"
                >
                    <button
                        type="button"
                        role="tab"
                        :aria-selected="view === 'lines'"
                        :class="[viewTab, view === 'lines' ? onTab : offTab]"
                        data-test="subtitleViewLines"
                        @click="view = 'lines'"
                    >
                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                            <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
                        </svg>
                        Lines
                    </button>
                    <button
                        type="button"
                        role="tab"
                        :aria-selected="view === 'translate'"
                        :class="[viewTab, view === 'translate' ? onTab : offTab]"
                        data-test="subtitleViewTranslate"
                        @click="view = 'translate'"
                    >
                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                            <path d="M3 5h12M9 3v2M5 9c1.5 4 4 6.5 8 8M13 5c-1 5-4 9-9 12M14 21l4-9 4 9M15.5 18h5" />
                        </svg>
                        Translate
                    </button>
                </div>

                <div class="relative flex shrink-0 items-center gap-2 border-b border-sky-100 px-5 py-3 dark:border-sky-400/10">
                    <div role="tablist" aria-label="Languages" class="flex flex-wrap gap-1.5">
                        <button
                            v-for="language in languages"
                            :key="language"
                            type="button"
                            role="tab"
                            :aria-selected="language === selected"
                            class="flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors"
                            :class="
                                language === selected
                                    ? 'border-sky-700 bg-sky-50 font-semibold text-sky-800 dark:border-sky-400 dark:bg-sky-400/15 dark:text-sky-200'
                                    : 'border-sky-200 bg-white font-medium text-slate-700 hover:bg-sky-50 dark:border-sky-400/12 dark:bg-transparent dark:text-slate-300'
                            "
                            data-test="subtitleLanguage"
                            @click="select(language)"
                        >
                            {{ labelOf(language) }}
                            <span class="font-normal opacity-75">{{ language }}</span>
                            <span v-if="isDirty(drafts[language])" class="h-1.5 w-1.5 rounded-full bg-amber-600" aria-label="unsaved"></span>
                        </button>
                        <button
                            type="button"
                            class="h-8 rounded-full border border-dashed border-sky-300 bg-white px-3 text-[13px] font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-400/30 dark:bg-transparent dark:text-sky-300"
                            :disabled="!media || loading"
                            data-test="showAddSubtitles"
                            @click="openAdd()"
                        >
                            + Add language
                        </button>
                    </div>
                    <div ref="optionsRef" class="ml-auto" @keydown.escape="optionsOpen = false">
                        <button
                            type="button"
                            class="chapter-toolbar-muted flex items-center gap-1.5"
                            :aria-expanded="optionsOpen"
                            aria-haspopup="menu"
                            data-test="subtitleOptions"
                            @click="optionsOpen = !optionsOpen"
                        >
                            {{ labelOf(selected!) }} options
                            <svg
                                class="h-4 w-4 transition-transform"
                                :class="{ 'rotate-180': optionsOpen }"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                aria-hidden="true"
                            >
                                <path d="M6 9l6 6 6-6" />
                            </svg>
                        </button>
                        <div
                            v-if="optionsOpen"
                            role="menu"
                            class="absolute top-full right-5 z-20 mt-1 flex w-64 flex-col gap-1 rounded-xl border border-slate-200 bg-white p-2 shadow-lg dark:border-slate-700 dark:bg-slate-800"
                            data-test="subtitleOptionsMenu"
                        >
                            <label class="flex flex-col gap-1 px-2 pt-1 pb-2 text-xs font-medium text-slate-500 dark:text-slate-400">
                                Name players show
                                <input v-model="draft.name" type="text" maxlength="100" :class="[input, 'h-8']" data-test="subtitleName" />
                            </label>
                            <button type="button" role="menuitem" class="rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-700" data-test="importSubtitles" @click="importInput?.click()">
                                Import .srt or .vtt…
                            </button>
                            <button type="button" role="menuitem" class="rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-700" :disabled="!draft.segments.length" data-test="exportSrt" @click="download('srt')">
                                Export .srt
                            </button>
                            <button type="button" role="menuitem" class="rounded-md px-2 py-1.5 text-left text-sm hover:bg-slate-100 disabled:opacity-50 dark:hover:bg-slate-700" :disabled="!draft.segments.length" data-test="exportVtt" @click="download('vtt')">
                                Export .vtt
                            </button>
                            <button type="button" role="menuitem" class="rounded-md px-2 py-1.5 text-left text-sm text-red-700 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-400/10" :disabled="saving || busy" data-test="removeSubtitles" @click="remove">
                                Remove {{ labelOf(selected!) }}
                            </button>
                        </div>
                        <input
                            ref="importInput"
                            type="file"
                            accept=".srt,.vtt,text/vtt,application/x-subrip"
                            class="hidden"
                            data-test="importSubtitlesFile"
                            @change="importInto"
                        />
                    </div>
                </div>

                <p v-if="error" class="m-0 shrink-0 px-5 pt-2.5 text-sm text-red-700 dark:text-red-400" data-test="subtitlesError">
                    {{ error }}
                    <button v-if="isConflict" type="button" class="chapter-toolbar-muted ml-1" @click="load">Read it again</button>
                </p>
                <p v-else-if="notice" class="m-0 shrink-0 px-5 pt-2.5 text-xs text-slate-500 dark:text-slate-400" data-test="subtitlesNotice">
                    {{ notice }}
                </p>

                <!-- Takes its full height: the body around it scrolls, not the list inside it. -->
                <div class="flex flex-none flex-col px-5 pt-3 pb-4">
                    <SubtitleLines
                        v-if="view === 'lines'"
                        v-model="draft.segments"
                        v-model:selected="selectedLine"
                        :duration="duration"
                        :get-current-time="getCurrentTime"
                        :on-seek="onSeek"
                    />
                    <template v-else-if="original && drafts[original]">
                        <p class="m-0 flex shrink-0 flex-wrap items-center gap-2 pb-3 text-sm text-slate-700 dark:text-slate-300">
                            Translating <strong class="text-zinc-900 dark:text-slate-100">{{ labelOf(selected!) }}</strong> from
                            <label class="flex items-center">
                                <span class="sr-only">Original language</span>
                                <select v-model="original" :class="[input, 'h-8.5 font-semibold']" data-test="subtitleOriginal">
                                    <option v-for="language in originals" :key="language" :value="language">{{ labelOf(language) }}</option>
                                </select>
                            </label>
                        </p>
                        <SubtitleCompare
                            v-model="draft.segments"
                            :original="drafts[original]!.segments"
                            :translation-name="labelOf(selected!)"
                            :get-current-time="getCurrentTime"
                            :on-seek="onSeek"
                        />
                    </template>
                    <div v-else class="flex flex-1 flex-col items-center justify-center gap-3.5 py-8 text-center" data-test="translateNeedsTwo">
                        <h4 class="m-0 text-lg font-semibold text-zinc-900 dark:text-slate-100">Add a second language to translate</h4>
                        <p class="m-0 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                            {{ labelOf(selected!) }} is the only language so far. Start a translation: its lines take the timings of {{ labelOf(selected!) }}, side by side, ready for the words.
                        </p>
                        <button type="button" class="chapter-save-btn" @click="openAdd({ copyFrom: selected! })">
                            Translate {{ labelOf(selected!) }} into…
                        </button>
                    </div>
                </div>
            </template>

            <div
                v-else-if="!loading && media"
                class="flex flex-1 flex-col items-center justify-center gap-3.5 p-8 text-center"
                data-test="subtitlesEmpty"
            >
                <h4 class="m-0 text-lg font-semibold text-zinc-900 dark:text-slate-100">This video has no subtitles yet</h4>
                <p class="m-0 max-w-sm text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                    Add a language from an .srt or .vtt file, or write the lines against the video. Once saved, every player offers it, in the app and on the web.
                </p>
                <button type="button" class="chapter-save-btn" data-test="addFirstSubtitles" @click="openAdd()">+ Add a language</button>
                <p class="m-0 text-[13px] text-slate-500 dark:text-slate-400">Or drop an .srt or .vtt file here</p>
            </div>
            <p v-if="!draft && error" class="m-0 px-5 pb-4 text-sm text-red-700 dark:text-red-400">{{ error }}</p>

            <div
                v-if="dropping"
                class="pointer-events-none absolute inset-2 flex items-center justify-center rounded-xl border-2 border-dashed border-sky-600 bg-sky-50/90 text-sm font-semibold text-sky-800 dark:bg-sky-950/80 dark:text-sky-200"
            >
                Drop the .srt or .vtt file
            </div>

            <div
                v-if="adding"
                class="fixed inset-0 z-100 flex items-center justify-center bg-slate-900/45 p-4 dark:bg-black/60"
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-subtitles-title"
                @click.self="adding = false"
            >
                <form
                    class="flex w-full max-w-[32.5rem] flex-col gap-5 rounded-2xl bg-white p-7 shadow-xl dark:bg-slate-800"
                    data-test="addSubtitlesForm"
                    @submit.prevent="addLanguage"
                >
                    <div class="flex flex-col gap-1.5">
                        <h2 id="add-subtitles-title" class="m-0 text-[1.1875rem] font-semibold text-zinc-900 dark:text-slate-100">
                            Add subtitles in a language
                        </h2>
                        <p class="m-0 text-sm text-slate-500 dark:text-slate-400">It goes into the video when you save it. Every player then offers it.</p>
                    </div>
                    <div class="grid grid-cols-2 gap-3.5">
                        <label class="flex flex-col gap-1.5 text-[13px] font-semibold text-slate-700 dark:text-slate-300">
                            Language code
                            <input v-model="newCode" type="text" list="subtitle-language-codes" placeholder="fr" :class="[input, 'h-10']" data-test="newSubtitleCode" />
                            <datalist id="subtitle-language-codes">
                                <option v-for="code in SUGGESTED" :key="code" :value="code">{{ languageName(code) }}</option>
                            </datalist>
                        </label>
                        <label class="flex flex-col gap-1.5 text-[13px] font-semibold text-slate-700 dark:text-slate-300">
                            Name players show
                            <input v-model="newName" type="text" maxlength="100" placeholder="Français" :class="[input, 'h-10']" data-test="newSubtitleName" />
                        </label>
                    </div>
                    <p v-if="newError" class="-mt-3 mb-0 text-xs text-red-700 dark:text-red-400">{{ newError }}</p>
                    <fieldset class="m-0 flex flex-col gap-2.5 border-0 p-0">
                        <legend class="mb-2.5 p-0 text-[13px] font-semibold text-slate-700 dark:text-slate-300">Start from</legend>
                        <label
                            class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5"
                            :class="newStart === 'empty' ? 'border-sky-700 bg-sky-50 dark:border-sky-400 dark:bg-sky-400/10' : 'border-sky-200 dark:border-sky-400/12'"
                        >
                            <input v-model="newStart" type="radio" value="empty" class="mt-0.5 h-4 w-4" />
                            <span class="flex flex-col gap-0.5">
                                <span class="text-sm font-semibold">Nothing</span>
                                <span class="text-[13px] text-slate-500 dark:text-slate-400">Write each line against the video</span>
                            </span>
                        </label>
                        <label
                            class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5"
                            :class="newStart === 'file' ? 'border-sky-700 bg-sky-50 dark:border-sky-400 dark:bg-sky-400/10' : 'border-sky-200 dark:border-sky-400/12'"
                        >
                            <input v-model="newStart" type="radio" value="file" class="mt-0.5 h-4 w-4" data-test="newSubtitleFromFile" />
                            <span class="flex flex-1 flex-col gap-2">
                                <span class="flex flex-col gap-0.5">
                                    <span class="text-sm font-semibold">An .srt or .vtt file</span>
                                    <span class="text-[13px] text-slate-500 dark:text-slate-400">
                                        <template v-if="newFile">{{ newFile.segments.length }} line{{ newFile.segments.length === 1 ? '' : 's' }} in {{ newFile.fileName }}</template>
                                        <template v-else>Its lines and timings, ready to check</template>
                                    </span>
                                </span>
                                <span class="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        class="flex h-8 items-center gap-1.5 rounded-lg border border-sky-600 bg-white px-3 text-[13px] font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-400 dark:bg-transparent dark:text-sky-300"
                                        data-test="chooseNewSubtitleFile"
                                        @click.prevent="chooseNewFile"
                                    >
                                        <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                            <path d="M12 15V3M7 8l5-5 5 5M5 21h14" />
                                        </svg>
                                        {{ newFile ? 'Choose another file' : 'Choose a file…' }}
                                    </button>
                                    <span v-if="!newFile" class="text-xs text-slate-500 dark:text-slate-400">or drop one here</span>
                                </span>
                                <input
                                    ref="newFileInput"
                                    type="file"
                                    accept=".srt,.vtt,text/vtt,application/x-subrip"
                                    class="hidden"
                                    data-test="newSubtitleFile"
                                    @change="pickNewFile"
                                />
                            </span>
                        </label>
                        <label
                            v-if="languages.length > 0"
                            class="flex cursor-pointer items-start gap-3 rounded-xl border p-3.5"
                            :class="newStart === 'copy' ? 'border-sky-700 bg-sky-50 dark:border-sky-400 dark:bg-sky-400/10' : 'border-sky-200 dark:border-sky-400/12'"
                        >
                            <input v-model="newStart" type="radio" value="copy" class="mt-0.5 h-4 w-4" data-test="newSubtitleFromCopy" />
                            <span class="flex flex-1 flex-col gap-2">
                                <span class="flex flex-col gap-0.5">
                                    <span class="text-sm font-semibold">A translation of another language</span>
                                    <span class="text-[13px] text-slate-500 dark:text-slate-400">Its timings, with the words to translate side by side</span>
                                </span>
                                <select v-model="newCopyFrom" :class="[input, 'h-8.5 self-start']" @focus="newStart = 'copy'">
                                    <option v-for="language in languages" :key="language" :value="language">
                                        {{ labelOf(language) }} · {{ drafts[language]?.loaded ? `${drafts[language]!.segments.length} lines` : language }}
                                    </option>
                                </select>
                            </span>
                        </label>
                    </fieldset>
                    <div class="flex justify-end gap-2.5">
                        <button
                            type="button"
                            class="h-10 rounded-lg border border-slate-300 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                            @click="adding = false"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            class="h-10 rounded-lg bg-sky-700 px-4.5 text-sm font-semibold text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                            :disabled="!canAdd"
                            data-test="addSubtitles"
                        >
                            {{ newStart === 'copy' ? 'Start translating' : 'Add' }}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    </section>
</template>
