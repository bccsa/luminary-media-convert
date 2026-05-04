<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, useId } from 'vue';

const props = withDefaults(
    defineProps<{
        open: boolean;
        title: string;
        /** Fallback message when the default slot is empty. */
        body?: string;
        /** Optional checkbox below the message (e.g. “also delete related resources”). */
        dangerOption?: { label: string };
        confirmLabel?: string;
        cancelLabel?: string;
        /** Shown on the confirm button while `loading` is true. */
        loadingLabel?: string;
        loading?: boolean;
    }>(),
    {
        body: '',
        confirmLabel: 'Delete',
        cancelLabel: 'Cancel',
        loadingLabel: 'Working…',
        loading: false,
    },
);

const emit = defineEmits<{
    'update:open': [value: boolean];
    /** `optionChecked` is true only when `dangerOption` is set and the box is checked. */
    confirm: [optionChecked: boolean];
}>();

const titleId = useId();
const optionChecked = ref(false);

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen) optionChecked.value = false;
    },
);

function close() {
    if (props.loading) return;
    emit('update:open', false);
}

function onConfirm() {
    const checked = !!props.dangerOption && optionChecked.value;
    emit('confirm', checked);
}

function onKeydown(e: KeyboardEvent) {
    if (!props.open || props.loading) return;
    if (e.key === 'Escape') {
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
            class="fixed inset-0 z-[100] flex items-center justify-center p-4"
            aria-modal="true"
            role="dialog"
            :aria-labelledby="titleId"
        >
            <button
                type="button"
                class="absolute inset-0 bg-zinc-900/50 backdrop-blur-[1px] dark:bg-black/60"
                aria-label="Close"
                :disabled="loading"
                @click="close"
            />
            <div
                class="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 shadow-xl ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900 dark:ring-white/10"
                @click.stop
            >
                <h2
                    :id="titleId"
                    class="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
                >
                    {{ title }}
                </h2>
                <div class="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                    <slot>{{ body }}</slot>
                </div>

                <label
                    v-if="dangerOption"
                    class="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-800/50"
                >
                    <input
                        v-model="optionChecked"
                        type="checkbox"
                        class="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-red-600 focus:ring-red-500 dark:border-zinc-600"
                        :disabled="loading"
                    />
                    <span class="text-sm text-zinc-700 dark:text-zinc-300">{{
                        dangerOption.label
                    }}</span>
                </label>

                <div class="mt-6 flex flex-wrap justify-end gap-2">
                    <button
                        type="button"
                        class="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800 cursor-pointer disabled:cursor-not-allowed"
                        :disabled="loading"
                        @click="close"
                    >
                        {{ cancelLabel }}
                    </button>
                    <button
                        type="button"
                        class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        :disabled="loading"
                        @click="onConfirm"
                    >
                        {{ loading ? loadingLabel : confirmLabel }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
