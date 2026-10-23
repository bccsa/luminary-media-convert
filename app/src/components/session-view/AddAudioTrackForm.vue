<script setup lang="ts">
/**
 * Adds an audio track to the existing video from a file on this machine or a
 * link (an audio or video file, or an HLS playlist): one of its audio streams
 * is picked, and the new track named and placed on the video's timeline. The
 * encode itself runs in the encoder.
 */
import { computed, ref, watch } from 'vue';
import { LanguageSelect } from '@luminary-media-converter/encode-config';
import { addAudioTrack, probeAudioSource } from '../../api';
import type { AddAudioTrackJob, AudioSource } from '../../types';

const props = defineProps<{
    sessionId: string;
    sessionToken: string | null;
    /** The master's ETag the panel read: the track is added over that version only. */
    etag: string;
    disabled?: boolean;
}>();

const emit = defineEmits<{ started: [job: AddAudioTrackJob]; cancel: [] }>();

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
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        starting.value = false;
    }
}
</script>

<template>
    <div
        class="flex flex-col gap-2 rounded-lg border border-slate-200 p-3 dark:border-slate-700"
        data-test="addAudioTrackForm"
    >
        <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-semibold text-slate-700 dark:text-slate-200">
                Add an audio track
            </p>
            <button
                type="button"
                class="chapter-toolbar-muted"
                @click="emit('cancel')"
            >
                Cancel
            </button>
        </div>

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
                    class="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-600 dark:bg-slate-900"
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
            <span
                v-if="path"
                class="min-w-0 truncate text-xs text-slate-500 dark:text-slate-400"
                :title="path"
                >{{ path.split(/[\\/]/).pop() }}</span
            >
        </div>
        <p v-if="reading" class="text-xs text-slate-500">Reading the file…</p>

        <template v-if="source">
            <label
                v-if="source.audioTracks.length > 1"
                class="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400"
            >
                Audio in the file
                <select
                    v-model.number="sourceTrackIndex"
                    class="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    data-test="audioSourceTrack"
                >
                    <option
                        v-for="(track, i) in source.audioTracks"
                        :key="i"
                        :value="i"
                    >
                        {{ streamLabel(track, i) }}
                    </option>
                </select>
            </label>
            <div class="grid grid-cols-[8rem_minmax(0,1fr)] gap-2">
                <label
                    class="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400"
                >
                    Language
                    <LanguageSelect
                        v-model="language"
                        aria-label="Language of the new track"
                    />
                </label>
                <label
                    class="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400"
                >
                    Name
                    <input
                        v-model="name"
                        type="text"
                        maxlength="100"
                        placeholder="Français"
                        class="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                        data-test="newTrackName"
                    />
                </label>
            </div>
            <label
                class="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400"
            >
                Starts at (seconds into the video)
                <input
                    v-model.number="offsetSec"
                    type="number"
                    step="0.1"
                    class="w-32 rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
                    data-test="newTrackOffset"
                />
                <span>
                    0 lines the file up with the video's start. A positive
                    number starts it later, a negative one skips its first
                    seconds. It is cut or padded with silence to the video's
                    length.
                </span>
            </label>
            <div class="flex justify-end">
                <button
                    type="button"
                    class="chapter-save-btn"
                    :disabled="!canAdd"
                    data-test="addAudioTrack"
                    @click="add"
                >
                    {{ starting ? 'Starting…' : 'Add track' }}
                </button>
            </div>
        </template>

        <p v-if="error" class="text-xs text-red-600 dark:text-red-400">
            {{ error }}
        </p>
    </div>
</template>
