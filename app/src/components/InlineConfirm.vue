<script setup lang="ts">
import { ref } from 'vue';

const props = withDefaults(defineProps<{
    /** Label for the trigger button */
    label?: string;
    /** Confirmation prompt text */
    prompt?: string;
    /** Show a secondary option (e.g., "Also delete S3 files?") */
    secondaryPrompt?: string;
    /** Label for the primary confirm button */
    confirmLabel?: string;
    /** Label for the secondary confirm button (when secondaryPrompt is set) */
    secondaryConfirmLabel?: string;
    /** Label for the secondary decline button (when secondaryPrompt is set) */
    secondaryDeclineLabel?: string;
    /** Whether the action is in progress */
    loading?: boolean;
    /** Loading text */
    loadingLabel?: string;
    /** Size variant */
    size?: 'sm' | 'md';
}>(), {
    label: 'Delete',
    prompt: 'Are you sure?',
    secondaryPrompt: undefined,
    confirmLabel: 'Yes',
    secondaryConfirmLabel: 'Yes',
    secondaryDeclineLabel: 'No',
    loading: false,
    loadingLabel: 'Deleting...',
    size: 'sm',
});

const emit = defineEmits<{
    confirm: [withSecondary: boolean];
}>();

const state = ref<'idle' | 'confirm' | 'secondary'>('idle');

function start() {
    state.value = props.secondaryPrompt ? 'secondary' : 'confirm';
}

function cancel() {
    state.value = 'idle';
}

function onConfirm(withSecondary: boolean) {
    state.value = 'idle';
    emit('confirm', withSecondary);
}

const btnBase = 'rounded cursor-pointer transition-colors whitespace-nowrap';
const btnSm = 'px-2 py-1 text-xs';
const btnMd = 'px-4 py-2 text-xs font-semibold rounded-lg';
const btnSize = props.size === 'md' ? btnMd : btnSm;
const textSize = props.size === 'md' ? 'text-sm' : 'text-xs';
</script>

<template>
    <div class="relative inline-flex items-center gap-2">
        <!-- Loading -->
        <span v-if="loading" :class="[textSize, 'text-slate-500 dark:text-slate-500']">
            {{ loadingLabel }}
        </span>

        <!-- Idle: trigger button (always in flow to maintain layout) -->
        <button
            v-else-if="state === 'idle'"
            type="button"
            :class="[
                btnBase,
                btnSize,
                'border border-red-200 text-red-700 hover:bg-red-50 dark:border-red-800/50 dark:text-red-400 dark:hover:bg-red-950/30',
            ]"
            @click="start"
        >
            {{ label }}
        </button>

        <!-- Confirmation overlay — positioned absolute right so it doesn't shift layout -->
        <div
            v-else
            class="absolute right-0 z-10 flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 shadow-lg ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-900 dark:ring-white/10"
        >
            <!-- Simple confirm -->
            <template v-if="state === 'confirm'">
                <span :class="[textSize, 'whitespace-nowrap text-slate-600 dark:text-slate-400']">{{ prompt }}</span>
                <button
                    type="button"
                    :class="[btnBase, btnSm, 'bg-red-600 text-white hover:bg-red-500']"
                    @click="onConfirm(false)"
                >
                    {{ confirmLabel }}
                </button>
                <button
                    type="button"
                    :class="[
                        btnBase,
                        btnSm,
                        'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
                    ]"
                    @click="cancel"
                >
                    Cancel
                </button>
            </template>

            <!-- Secondary choice (e.g., delete S3 files?) -->
            <template v-else-if="state === 'secondary'">
                <span :class="[textSize, 'whitespace-nowrap text-slate-600 dark:text-slate-400']">{{ secondaryPrompt }}</span>
                <button
                    type="button"
                    :class="[btnBase, btnSm, 'bg-red-600 text-white hover:bg-red-500']"
                    @click="onConfirm(true)"
                >
                    {{ secondaryConfirmLabel }}
                </button>
                <button
                    type="button"
                    :class="[
                        btnBase,
                        btnSm,
                        'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
                    ]"
                    @click="onConfirm(false)"
                >
                    {{ secondaryDeclineLabel }}
                </button>
                <button
                    type="button"
                    :class="[
                        btnBase,
                        btnSm,
                        'border border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800',
                    ]"
                    @click="cancel"
                >
                    Cancel
                </button>
            </template>
        </div>
    </div>
</template>
