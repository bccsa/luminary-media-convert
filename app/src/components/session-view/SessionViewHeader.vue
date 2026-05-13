<script setup lang="ts">
import StatusBadge from '../StatusBadge.vue';

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

withDefaults(
    defineProps<{
        sessionName: string;
        session: Record<string, any>;
        editingName: boolean;
        savingName: boolean;
        /** Subtitle next to session name e.g. "Created 5 min ago" */
        createdSubtitle: string;
        displayEncoder: string | undefined;
        displaySegmentFormat?: string;
        isEncrypted: boolean;
        /** Session detail: back control before the title row */
        showBackToSessions?: boolean;
    }>(),
    { showBackToSessions: false },
);

const backLinkClass =
    '-ml-1 inline-flex shrink-0 items-center justify-center self-center rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200';

const nameInput = defineModel<string>('nameInput', { required: true });

const emit = defineEmits<{
    saveName: [];
    cancelEditName: [];
    startEditName: [];
}>();
</script>

<template>
    <header class="flex flex-col gap-3">
        <div class="min-w-0">
            <!-- Editing mode: inline input + save/cancel -->
            <div v-if="editingName" class="flex flex-wrap items-center gap-2">
                <router-link
                    v-if="showBackToSessions"
                    to="/sessions"
                    :class="backLinkClass"
                    title="Back to sessions list"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    <span class="sr-only">Back to sessions list</span>
                </router-link>
                <input
                    v-model="nameInput"
                    type="text"
                    class="input min-w-0 flex-1 text-lg font-semibold"
                    placeholder="Session name"
                    @keyup.enter="emit('saveName')"
                    @keyup.escape="emit('cancelEditName')"
                />
                <button
                    type="button"
                    :disabled="savingName"
                    class="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
                    @click="emit('saveName')"
                >
                    {{ savingName ? '…' : 'Save' }}
                </button>
                <button
                    type="button"
                    class="cursor-pointer rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-700"
                    @click="emit('cancelEditName')"
                >
                    Cancel
                </button>
            </div>

            <!-- Display mode: clickable name + detail badges -->
            <div v-else class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
                <router-link
                    v-if="showBackToSessions"
                    to="/sessions"
                    :class="backLinkClass"
                    title="Back to sessions list"
                >
                    <svg class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                    </svg>
                    <span class="sr-only">Back to sessions list</span>
                </router-link>
                <div class="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h1
                        class="min-w-0 cursor-pointer text-2xl font-semibold tracking-tight text-slate-900 transition-colors hover:text-slate-600 dark:text-slate-100 dark:hover:text-slate-400"
                        :title="sessionName ? 'Click to rename' : 'Click to add a name'"
                        @click="emit('startEditName')"
                    >
                        {{ sessionName || 'Untitled session' }}
                    </h1>
                    <template v-if="session.createdAt && createdSubtitle">
                        <span class="shrink-0 text-slate-400" aria-hidden="true">·</span>
                        <span class="min-w-0 text-xs font-medium text-slate-500 dark:text-slate-400 sm:text-sm">{{ createdSubtitle }}</span>
                    </template>
                </div>
                <StatusBadge
                    v-if="displayEncoder && encoderConfig[displayEncoder]"
                    class="shrink-0"
                    :label="encoderConfig[displayEncoder].label"
                    :icon="encoderConfig[displayEncoder].icon"
                    :color="displayEncoder === 'cpu' ? 'text-slate-700 dark:text-slate-400' : 'text-violet-700 dark:text-violet-400'"
                    :border-color="displayEncoder === 'cpu' ? 'border-slate-300 dark:border-slate-700' : 'border-violet-300 dark:border-violet-700/60'"
                />
                <StatusBadge
                    v-if="displaySegmentFormat === 'mpegts'"
                    class="shrink-0"
                    label="MPEG-TS"
                    color="text-amber-700 dark:text-amber-400"
                    border-color="border-amber-300 dark:border-amber-700/60"
                    :icon="ICON_PATHS.warning"
                    title="MPEG-TS segments used because source streams have misaligned start times."
                />
            </div>

            <div v-if="isEncrypted || session.imported" class="mt-3 flex flex-wrap items-center gap-2">
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
    </header>
</template>
