<script setup lang="ts">
/**
 * The dialog that adds a camera angle to the existing video, from a file on
 * this machine or a link (a video file, or an HLS playlist): one of its video
 * streams is picked, and the new angle named and placed on the video's
 * timeline. For a video with a single picture it also names that picture,
 * which becomes the main angle. It closes once the add has started; the encode
 * runs in the encoder, and the panel behind shows its progress.
 */
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import { addVideoAngle, probeVideoSource } from '../../api';
import FormSelect, { type SelectOption } from '../FormSelect.vue';
import type { AddVideoAngleJob, VideoSource } from '../../types';

const props = defineProps<{
    open: boolean;
    sessionId: string;
    sessionToken: string | null;
    /** The master's ETag the panel read: the angle is added over that version only. */
    etag: string;
    /** The video has a single picture: it is named as the main angle too. */
    namesMain: boolean;
    disabled?: boolean;
}>();

const emit = defineEmits<{
    'update:open': [value: boolean];
    started: [job: AddVideoAngleJob];
}>();

const titleId = useId();

/** The preload bridge, absent when the UI is open in a plain browser. */
const desktop = computed(() =>
    typeof window !== 'undefined' ? window.luminary : undefined
);

const path = ref('');
const typedPath = ref('');
const source = ref<VideoSource | null>(null);
const sourceTrackIndex = ref(0);
const name = ref('');
const mainName = ref('Main');
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
        source.value = await probeVideoSource(props.sessionId, token, next);
        path.value = next;
        sourceTrackIndex.value = source.value.videoTracks[0]?.index ?? 0;
    } catch (err) {
        error.value = (err as Error).message;
    } finally {
        reading.value = false;
    }
}

async function browse(): Promise<void> {
    const picked = await desktop.value?.showOpenDialog();
    if (picked) await choose(picked);
}

function streamLabel(
    track: VideoSource['videoTracks'][number],
    i: number
): string {
    const parts = [`Video ${i + 1}`];
    if (track.width && track.height)
        parts.push(`${track.width}×${track.height}`);
    if (track.frameRate) parts.push(`${track.frameRate} fps`);
    if (track.name) parts.push(track.name);
    return parts.join(' · ');
}

/** The source's video streams, as the custom dropdown lists them. */
const sourceOptions = computed<SelectOption[]>(() =>
    (source.value?.videoTracks ?? []).map((track, i) => ({
        value: track.index,
        label: streamLabel(track, i),
    }))
);

const canAdd = computed(
    () =>
        !!source.value &&
        !!name.value.trim() &&
        (!props.namesMain || !!mainName.value.trim()) &&
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
        const job = await addVideoAngle(props.sessionId, token, {
            path: path.value,
            sourceTrackIndex: sourceTrackIndex.value,
            name: name.value.trim(),
            ...(props.namesMain ? { mainName: mainName.value.trim() } : {}),
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
        name.value = '';
        mainName.value = 'Main';
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
                data-test="addVideoAngleForm"
                @click.stop
            >
                <div>
                    <h2
                        :id="titleId"
                        class="text-lg font-semibold text-slate-900 dark:text-slate-100"
                    >
                        Add a camera angle
                    </h2>
                    <p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
                        From a video file, or a link to one or to an HLS
                        playlist. Its picture is encoded in the same sizes as
                        this video and plays with this video's sound.
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
                            data-test="chooseAngleFile"
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
                                        ? 'or paste a link: https://…/video.mp4, …/master.m3u8'
                                        : 'A file path or a link: https://…/video.mp4, …/master.m3u8'
                                "
                                class="min-w-0 flex-1 rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                                aria-label="Path or link of the video"
                                data-test="angleFilePath"
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
                        {{ Math.round(source.durationSec) }} s
                    </p>
                    <p v-if="reading" class="text-xs text-slate-500">
                        Reading it…
                    </p>
                </div>

                <template v-if="source">
                    <label
                        v-if="source.videoTracks.length > 1"
                        class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                        Picture in it
                        <FormSelect
                            v-model="sourceTrackIndex"
                            :options="sourceOptions"
                            numeric
                            variant="field"
                            size="sm"
                            presentation="custom"
                            aria-label="Picture in the file"
                            data-test="angleSourceTrack"
                        />
                    </label>
                    <div
                        class="grid gap-3"
                        :class="namesMain ? 'grid-cols-2' : 'grid-cols-1'"
                    >
                        <label
                            v-if="namesMain"
                            class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                        >
                            This video's picture
                            <input
                                v-model="mainName"
                                type="text"
                                maxlength="100"
                                class="w-full rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                                data-test="mainAngleName"
                            />
                        </label>
                        <label
                            class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                        >
                            New angle
                            <input
                                v-model="name"
                                type="text"
                                maxlength="100"
                                placeholder="Pulpit"
                                class="w-full rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                                data-test="newAngleName"
                            />
                        </label>
                    </div>
                    <p
                        v-if="namesMain"
                        class="-mt-2 text-xs text-slate-500 dark:text-slate-400"
                    >
                        This video has one picture so far. It stays the one that
                        plays first, under the name you give it.
                    </p>
                    <label
                        class="flex flex-col gap-1 text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                        Starts at (seconds into the video)
                        <input
                            v-model.number="offsetSec"
                            type="number"
                            step="0.1"
                            class="w-32 rounded-md border border-sky-200 bg-white px-2.5 py-1.5 text-sm text-zinc-900 outline-none transition-[border-color] focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                            data-test="newAngleOffset"
                        />
                        <span class="font-normal">
                            0 lines it up with the video's start. A positive
                            number starts it later, a negative one skips its
                            first seconds. It is cut, or held on black, to the
                            video's length.
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
                        data-test="addVideoAngle"
                        @click="add"
                    >
                        {{ starting ? 'Starting…' : 'Add angle' }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
