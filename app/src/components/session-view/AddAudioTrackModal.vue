<script setup lang="ts">
/**
 * The dialog that adds an audio track to the existing video, from a file on
 * this machine or a link (an audio or video file, or an HLS playlist): one of
 * its audio streams is picked, and the new track named and placed on the
 * video's timeline. It closes once the add has started; the encode runs in the
 * encoder, and the panel behind shows its progress.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { LanguageSelect } from '@luminary-media-converter/encode-config';
import { addAudioTrack, probeAudioSource } from '../../api';
import FormSelect, { type SelectOption } from '../FormSelect.vue';
import type { AddAudioTrackJob, AudioSource } from '../../types';

const props = defineProps<{
    open: boolean;
    sessionId: string;
    sessionToken: string | null;
    /** The master's ETag the panel read: the track is added over that version only. */
    etag: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    started: [job: AddAudioTrackJob];
}>();

const titleId = useId();

/** The preload bridge, absent when the UI is open in a plain browser. */
const desktop = computed(() =>
    typeof window !== 'undefined' ? window.luminary : undefined
);

const path = ref('');
const typedPath = ref('');
const source = ref<AudioSource | null>(null);
const sourceTrackIndex = ref(0);
const language = ref('');
const name = ref('');
const offsetSec = ref(0);
const reading = ref(false);
const starting = ref(false);
const error = ref<string | null>(null);

async function choose(next: string): Promise<void> {
    const token = props.sessionToken;
    if (!token || !next) return;
    reading.value = true;
    error.value = null;
    source.value = null;
    try {
        source.value = await probeAudioSource(props.sessionId, token, next);
        path.value = next;
        sourceTrackIndex.value = 0;
        // The stream's own language, when it states one, is the likeliest answer.
        language.value = source.value.audioTracks[0]?.language ?? '';
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        reading.value = false;
    }
}

// The stream picked says its language more often than not: offered until the editor types their own.
watch(sourceTrackIndex, (index, before) => {
    const tracks = source.value?.audioTracks ?? [];
    const previous = tracks[before]?.language ?? '';
    if (language.value === previous)
        language.value = tracks[index]?.language ?? '';
});

async function browse(): Promise<void> {
    const picked = await desktop.value?.showOpenDialog();
    if (picked) await choose(picked);
}

function streamLabel(
    track: AudioSource['audioTracks'][number],
    i: number
): string {
    const parts = [`Track ${i + 1}`];
    if (track.language) parts.push(track.language);
    if (track.name) parts.push(track.name);
    if (track.channels) parts.push(`${track.channels} ch`);
    return parts.join(' · ');
}

/** The source's audio streams, as the custom dropdown lists them. */
const sourceOptions = computed<SelectOption[]>(() =>
    (source.value?.audioTracks ?? []).map((track, i) => ({
        value: i,
        label: streamLabel(track, i),
    }))
);

const canAdd = computed(
    () =>
        !!source.value &&
        !!language.value.trim() &&
        !!name.value.trim() &&
        Number.isFinite(offsetSec.value) &&
        !starting.value &&
        !props.disabled
);

async function add(): Promise<void> {
    const token = props.sessionToken;
    if (!token || !canAdd.value) return;
    starting.value = true;
    error.value = null;
    try {
        const job = await addAudioTrack(props.sessionId, token, {
            path: path.value,
            sourceTrackIndex: sourceTrackIndex.value,
            language: language.value.trim(),
            name: name.value.trim(),
            offsetSec: offsetSec.value,
            ifMatch: props.etag,
        });
        emit('started', job);
        emit('update:open', false);
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        starting.value = false;
    }
}

function close(): void {
    if (starting.value) return;
    emit('update:open', false);
}

// Each opening starts from nothing: a half-filled earlier attempt is not this one.
watch(
    () => props.open,
    (isOpen) => {
        if (!isOpen) return;
        path.value = '';
        typedPath.value = '';
        source.value = null;
        sourceTrackIndex.value = 0;
        language.value = '';
        name.value = '';
        offsetSec.value = 0;
        error.value = null;
    }
);

function onKeydown(e: KeyboardEvent): void {
    if (props.open && e.key === 'Escape') {
        e.preventDefault();
        close();
    }
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
    <Teleport to="body">
        <div
            v-if="open"
            class="fixed inset-0 z-100 flex items-center justify-center p-4"
            aria-modal="true"
            role="dialog"
            :aria-labelledby="titleId"
        >
            <button
                type="button"
                class="absolute inset-0 bg-slate-900/50 backdrop-blur-[1px] dark:bg-black/60"
                aria-label="Close"
                :disabled="starting"
                @click="close"
            />
            <div
                class="relative flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-xl ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800 dark:ring-white/10"
                data-test="addAudioTrackForm"
                @click.stop
            >
                <div>
                    <h2
                        :id="titleId"
                        class="text-lg font-semibold text-slate-900 dark:text-slate-100"
                    >
                        Add an audio track
                    </h2>
                    <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                        From an audio or video file, or a link to one or to an
                        HLS playlist. It is encoded to match this video and
                        added beside its other tracks.
                    </p>
                </div>

                <div class="flex flex-col gap-2">
                    <span
                        class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                        >Source</span
                    >
                    <div class="flex flex-wrap items-center gap-2">
                        <button
                            v-if="desktop"
                            type="button"
                            class="chapter-toolbar-muted"
                            :disabled="reading"
                            data-test="chooseAudioFile"
                            @click="browse"
                        >
                            Choose file…
                        </button>
                        <!-- A link works in the desktop app too; a typed path is what a browser has instead of the dialog. -->
                        <form
                            class="flex min-w-0 flex-1 gap-2"
                            @submit.prevent="choose(typedPath.trim())"
                        >
                            <input
                                v-model="typedPath"
                                type="text"
                                :placeholder="
                                    desktop
                                        ? 'or paste a link: https://…/audio.mp3, …/master.m3u8'
                                        : 'A file path or a link: https://…/audio.mp3, …/master.m3u8'
                                "
                                class="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                                aria-label="Path or link of the audio"
                                data-test="audioFilePath"
                            />
                            <button
                                type="submit"
                                class="chapter-toolbar-muted"
                                :disabled="reading"
                            >
                                Read
                            </button>
                        </form>
                    </div>
                    <p
                        v-if="path && source"
                        class="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400"
                        :title="path"
                    >
                        {{ path.split(/[\\/]/).pop() }} ·
                        {{ source.audioTracks.length }} audio track{{
                            source.audioTracks.length === 1 ? '' : 's'
                        }}
                    </p>
                    <p v-if="reading" class="text-xs text-slate-500">
                        Reading it…
                    </p>
                </div>

                <template v-if="source">
                    <label
                        v-if="source.audioTracks.length > 1"
                        class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                        Audio in it
                        <FormSelect
                            v-model="sourceTrackIndex"
                            :options="sourceOptions"
                            numeric
                            variant="field"
                            size="sm"
                            presentation="custom"
                            aria-label="Audio in the file"
                            data-test="audioSourceTrack"
                        />
                    </label>
                    <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-3">
                        <label
                            class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                        >
                            Language
                            <LanguageSelect
                                v-model="language"
                                aria-label="Language of the new track"
                            />
                        </label>
                        <label
                            class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                        >
                            Name
                            <input
                                v-model="name"
                                type="text"
                                maxlength="100"
                                placeholder="Français"
                                class="w-full rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                                data-test="newTrackName"
                            />
                        </label>
                    </div>
                    <label
                        class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                        Starts at (seconds into the video)
                        <input
                            v-model.number="offsetSec"
                            type="number"
                            step="0.1"
                            class="w-32 rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                            data-test="newTrackOffset"
                        />
                        <span class="font-normal">
                            0 lines it up with the video's start. A positive
                            number starts it later, a negative one skips its
                            first seconds. It is cut or padded with silence to
                            the video's length.
                        </span>
                    </label>
                </template>

                <p v-if="error" class="text-sm text-red-600 dark:text-red-400">
                    {{ error }}
                </p>

                <div class="flex flex-wrap justify-end gap-2">
                    <button
                        type="button"
                        class="cursor-pointer rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-700"
                        :disabled="starting"
                        @click="close"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        class="cursor-pointer rounded-lg bg-sky-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-sky-500 dark:hover:bg-sky-400"
                        :disabled="!canAdd"
                        data-test="addAudioTrack"
                        @click="add"
                    >
                        {{ starting ? 'Starting…' : 'Add track' }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
