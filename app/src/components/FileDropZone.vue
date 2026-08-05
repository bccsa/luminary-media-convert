<script setup lang="ts">
import { ref } from 'vue';
import {
    isDesktop,
    localFileFromDrop,
    pickLocalFile,
    type LocalFile,
} from '../desktop';

/**
 * Two ways of naming the same file.
 *
 * On the web the app only ever gets a File, and uploads its bytes. In the
 * desktop build the encoder is on this machine and can read the file where it
 * lies, so what matters is the absolute path — which a browser will not hand
 * out, and which the Electron preload provides instead.
 */
const emit = defineEmits<{
    'update:file': [file: File | null];
    'update:localFile': [file: LocalFile | null];
}>();

const desktop = isDesktop();
const dragging = ref(false);
/** Name and size only: enough to render, from either source. */
const selectedFile = ref<{ name: string; size: number } | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function selectFile(file: File | null) {
    selectedFile.value = file ? { name: file.name, size: file.size } : null;
    emit('update:file', file);
}

function selectLocalFile(file: LocalFile | null) {
    selectedFile.value = file ? { name: file.name, size: file.size } : null;
    emit('update:localFile', file);
}

async function onDrop(e: DragEvent) {
    dragging.value = false;
    const file = e.dataTransfer?.files[0] ?? null;

    if (desktop && file) {
        const local = await localFileFromDrop(file);
        // Falls back to the upload path if the path cannot be recovered —
        // better a slower route than a dead drop target.
        if (local) return selectLocalFile(local);
    }
    selectFile(file);
}

async function onBrowse() {
    if (desktop) {
        // The native dialog gives an unambiguous path and filters to the
        // extensions the encoder accepts; a file input gives neither.
        const local = await pickLocalFile();
        if (local) selectLocalFile(local);
        return;
    }
    fileInput.value?.click();
}

function onInputChange(e: Event) {
    const input = e.target as HTMLInputElement;
    selectFile(input.files?.[0] ?? null);
}

function clear() {
    selectedFile.value = null;
    emit('update:file', null);
    emit('update:localFile', null);
    if (fileInput.value) fileInput.value.value = '';
}
</script>

<template>
    <div
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
        :class="[
            'relative rounded-xl border-2 border-dashed p-8 text-center transition-colors',
            dragging
                ? 'border-slate-400 bg-slate-50 dark:bg-slate-950/30'
                : 'border-slate-200 bg-slate-50/60 hover:border-slate-300 dark:border-slate-600 dark:bg-slate-800/30 dark:hover:border-slate-500',
        ]"
    >
        <input
            ref="fileInput"
            type="file"
            class="hidden"
            accept="video/*,audio/*"
            @change="onInputChange"
        />

        <template v-if="!selectedFile">
            <div class="mb-3 text-slate-500 dark:text-slate-400">
                <svg class="mx-auto h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
            </div>
            <p class="text-sm text-slate-600 dark:text-slate-400">
                Drag and drop your media file here, or
                <button
                    type="button"
                    class="font-medium text-slate-600 underline underline-offset-2 hover:text-slate-500 dark:text-slate-400 dark:hover:text-slate-300"
                    @click="onBrowse"
                >
                    browse
                </button>
            </p>
        </template>

        <template v-else>
            <div class="flex items-center justify-center gap-3">
                <svg class="h-6 w-6 shrink-0 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <div class="text-left text-sm">
                    <p class="font-medium text-slate-900 dark:text-slate-100">{{ selectedFile.name }}</p>
                    <p class="text-slate-500 dark:text-slate-400">{{ formatSize(selectedFile.size) }}</p>
                </div>
                <button
                    type="button"
                    class="ml-2 rounded p-1 text-slate-500 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-700 dark:hover:text-slate-300"
                    @click="clear"
                >
                    <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </template>
    </div>
</template>
