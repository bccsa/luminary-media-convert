<script setup lang="ts">
import StatusBadge from '../StatusBadge.vue';

const statusConfig: Record<string, { label: string; color: string; borderColor: string }> = {
    created: { label: 'Created', color: 'text-zinc-700 dark:text-zinc-400', borderColor: 'border-zinc-300 dark:border-zinc-700' },
    uploading: { label: 'Uploading', color: 'text-cyan-700 dark:text-cyan-400', borderColor: 'border-cyan-300 dark:border-cyan-700/60' },
    uploaded: { label: 'Uploaded', color: 'text-zinc-700 dark:text-zinc-400', borderColor: 'border-zinc-300 dark:border-zinc-700' },
    queued: { label: 'Queued', color: 'text-amber-700 dark:text-amber-400', borderColor: 'border-amber-300 dark:border-amber-700/60' },
    encoding: { label: 'Encoding', color: 'text-indigo-700 dark:text-indigo-400', borderColor: 'border-indigo-300 dark:border-indigo-700/60' },
    encrypting: { label: 'Encrypting', color: 'text-amber-700 dark:text-amber-400', borderColor: 'border-amber-300 dark:border-amber-700/60' },
    uploading_to_s3: { label: 'Uploading to S3', color: 'text-cyan-700 dark:text-cyan-400', borderColor: 'border-cyan-300 dark:border-cyan-700/60' },
    completed: { label: 'Completed', color: 'text-emerald-700 dark:text-emerald-400', borderColor: 'border-emerald-300 dark:border-emerald-700/60' },
    failed: { label: 'Failed', color: 'text-red-700 dark:text-red-400', borderColor: 'border-red-300 dark:border-red-700/60' },
    imported: { label: 'Imported', color: 'text-violet-700 dark:text-violet-400', borderColor: 'border-violet-300 dark:border-violet-700/60' },
};

const ICON_PATHS = {
    cpu: 'M9 3.5V2m0 17.5V21M5.06 5.06l-.94-.94m13.76 13.76-.94-.94M2 12H3.5m17 0H22M5.06 18.94l-.94.94M18.82 5.06l.94-.94M12 8a4 4 0 100 8 4 4 0 000-8z',
    gpu: 'M13 10V3L4 14h7v7l9-11h-7z',
    warning: 'M12 9v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    lock: 'M5 11V7a5 5 0 0110 0v4M3 11h18v11a2 2 0 01-2 2H5a2 2 0 01-2-2V11z',
} as Record<string, string>;

const encoderConfig: Record<string, { label: string; icon: string }> = {
    cpu: { label: 'CPU', icon: ICON_PATHS.cpu },
    nvidia: { label: 'NVIDIA GPU', icon: ICON_PATHS.gpu },
    apple: { label: 'Apple GPU', icon: ICON_PATHS.gpu },
};

defineProps<{
    sessionId: string;
    sessionName: string;
    session: Record<string, any>;
    editingName: boolean;
    savingName: boolean;
    currentStatus: string | null;
    /** Subtitle under session id e.g. "Created 5 min ago" */
    createdSubtitle: string;
    displayEncoder: string | undefined;
    displaySegmentFormat?: string;
    isEncrypted: boolean;
    showEncoding: boolean;
    pollerStatus: string | null | undefined;
    isCompleted: boolean;
    hasS3Files: boolean;
    showMoveForm: boolean;
    showRenameForm: boolean;
    isTerminal: boolean;
}>();

const nameInput = defineModel<string>('nameInput', { required: true });

const emit = defineEmits<{
    saveName: [];
    cancelEditName: [];
    startEditName: [];
    cancelEncode: [];
    moveToPost: [];
    renameToPost: [];
    deleteSession: [];
}>();
</script>

<template>
    <header class="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div class="min-w-0 flex-1">
            <div v-if="editingName" class="flex flex-wrap items-center gap-2">
                <input
                    v-model="nameInput"
                    type="text"
                    class="input min-w-0 flex-1 text-lg font-semibold"
                    placeholder="Session name"
                    @keyup.enter="emit('saveName')"
                    @keyup.escape="emit('cancelEditName')"
                />
                <StatusBadge
                    class="shrink-0"
                    :label="currentStatus ? statusConfig[currentStatus]?.label ?? currentStatus : '--'"
                    :color="statusConfig[currentStatus ?? '']?.color ?? 'text-zinc-700 dark:text-zinc-400'"
                    :border-color="statusConfig[currentStatus ?? '']?.borderColor ?? 'border-zinc-300 dark:border-zinc-700'"
                />
                <button
                    type="button"
                    :disabled="savingName"
                    class="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    @click="emit('saveName')"
                >
                    {{ savingName ? '…' : 'Save' }}
                </button>
                <button
                    type="button"
                    class="cursor-pointer rounded-lg border border-zinc-300 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    @click="emit('cancelEditName')"
                >
                    Cancel
                </button>
            </div>
            <div
                v-else
                class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2"
            >
                <h1
                    class="min-w-0 cursor-pointer text-2xl font-semibold tracking-tight text-zinc-900 transition-colors hover:text-indigo-600 dark:text-zinc-100 dark:hover:text-indigo-400"
                    @click="emit('startEditName')"
                    :title="sessionName ? 'Click to rename' : 'Click to add a name'"
                >
                    {{ sessionName || 'Untitled session' }}
                </h1>
                <StatusBadge
                    class="shrink-0"
                    :label="currentStatus ? statusConfig[currentStatus]?.label ?? currentStatus : '--'"
                    :color="statusConfig[currentStatus ?? '']?.color ?? 'text-zinc-700 dark:text-zinc-400'"
                    :border-color="statusConfig[currentStatus ?? '']?.borderColor ?? 'border-zinc-300 dark:border-zinc-700'"
                />
            </div>
            <div class="mt-1.5 flex flex-wrap items-center gap-2">
                <p class="font-mono text-xs text-zinc-500 dark:text-zinc-400">{{ sessionId }}</p>
                <span v-if="session.createdAt" class="text-xs text-zinc-500 dark:text-zinc-500">·</span>
                <p v-if="session.createdAt" class="text-xs text-zinc-500 dark:text-zinc-400">{{ createdSubtitle }}</p>
            </div>
            <div
                v-if="
                    (displayEncoder && encoderConfig[displayEncoder])
                    || displaySegmentFormat === 'mpegts'
                    || isEncrypted
                    || session.imported
                "
                class="mt-3 flex flex-wrap items-center gap-2"
            >
                <StatusBadge
                    v-if="displayEncoder && encoderConfig[displayEncoder]"
                    :label="encoderConfig[displayEncoder].label"
                    :icon="encoderConfig[displayEncoder].icon"
                    :color="displayEncoder === 'cpu' ? 'text-zinc-700 dark:text-zinc-400' : 'text-violet-700 dark:text-violet-400'"
                    :border-color="displayEncoder === 'cpu' ? 'border-zinc-300 dark:border-zinc-700' : 'border-violet-300 dark:border-violet-700/60'"
                />
                <StatusBadge
                    v-if="displaySegmentFormat === 'mpegts'"
                    label="MPEG-TS"
                    color="text-amber-700 dark:text-amber-400"
                    border-color="border-amber-300 dark:border-amber-700/60"
                    :icon="ICON_PATHS.warning"
                    title="MPEG-TS segments used because source streams have misaligned start times."
                />
                <StatusBadge
                    v-if="isEncrypted"
                    label="Encrypted"
                    color="text-amber-700 dark:text-amber-400"
                    border-color="border-amber-300 dark:border-amber-700/60"
                    :icon="ICON_PATHS.lock"
                />
                <StatusBadge
                    v-if="session.imported"
                    label="Imported"
                    color="text-violet-700 dark:text-violet-400"
                    border-color="border-violet-300 dark:border-violet-700/60"
                />
            </div>
        </div>
        <div class="flex shrink-0 flex-wrap items-center gap-2">
            <router-link
                to="/sessions/new"
                class="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-indigo-500"
            >
                New session
            </router-link>
            <details class="relative">
                <summary
                    class="flex cursor-pointer list-none items-center justify-center rounded-xl border border-zinc-300 bg-white px-3 py-2.5 text-zinc-700 shadow-sm transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900/80 dark:text-zinc-200 dark:hover:bg-zinc-800 [&::-webkit-details-marker]:hidden"
                >
                    <span class="sr-only">More actions</span>
                    <svg class="h-5 w-5" fill="currentColor" viewBox="0 0 24 24">
                        <path d="M12 8a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z" />
                    </svg>
                </summary>
                <div
                    class="absolute right-0 z-20 mt-2 min-w-[12rem] overflow-hidden rounded-xl border border-zinc-200/90 bg-white py-1 text-sm shadow-xl ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:ring-white/10"
                >
                    <button
                        v-if="showEncoding && (pollerStatus === 'queued' || pollerStatus === 'encoding' || pollerStatus === 'encrypting')"
                        type="button"
                        class="block w-full px-4 py-2.5 text-left text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        @click="emit('cancelEncode')"
                    >
                        Cancel encoding
                    </button>
                    <button
                        v-if="isCompleted && hasS3Files && !showMoveForm && !showRenameForm"
                        type="button"
                        class="block w-full px-4 py-2.5 text-left text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        @click="emit('moveToPost')"
                    >
                        Move files…
                    </button>
                    <button
                        v-if="isCompleted && hasS3Files && !showMoveForm && !showRenameForm"
                        type="button"
                        class="block w-full px-4 py-2.5 text-left text-zinc-800 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        @click="emit('renameToPost')"
                    >
                        Rename prefix…
                    </button>
                    <button
                        v-if="isTerminal"
                        type="button"
                        class="block w-full px-4 py-2.5 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                        @click="emit('deleteSession')"
                    >
                        Delete session…
                    </button>
                </div>
            </details>
        </div>
    </header>
</template>
