<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';

const props = withDefaults(
    defineProps<{
        open: boolean;
        /** Display name (session title or fallback id). */
        sessionLabel: string;
        /** When true, offers “also delete S3 files”. */
        hasS3Files: boolean;
        loading?: boolean;
    }>(),
    { loading: false },
);

const emit = defineEmits<{
    'update:open': [value: boolean];
    confirm: [withFiles: boolean];
}>();

const deleteS3Too = ref(false);

watch(
    () => props.open,
    (isOpen) => {
        if (isOpen) deleteS3Too.value = false;
    },
);

function close() {
    if (props.loading) return;
    emit('update:open', false);
}

function onConfirm() {
    const withFiles = props.hasS3Files && deleteS3Too.value;
    emit('confirm', withFiles);
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
            aria-labelledby="delete-session-modal-title"
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
                    id="delete-session-modal-title"
                    class="text-lg font-semibold text-zinc-900 dark:text-zinc-100"
                >
                    Delete session
                </h2>
                <p class="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
                    Remove
                    <span class="font-medium text-zinc-900 dark:text-zinc-200">{{
                        sessionLabel || 'this session'
                    }}</span>
                    from your account. This cannot be undone.
                </p>

                <label
                    v-if="hasS3Files"
                    class="mt-4 flex cursor-pointer items-start gap-3 rounded-lg border border-zinc-200 bg-zinc-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-800/50"
                >
                    <input
                        v-model="deleteS3Too"
                        type="checkbox"
                        class="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300 text-red-600 focus:ring-red-500 dark:border-zinc-600"
                        :disabled="loading"
                    />
                    <span class="text-sm text-zinc-700 dark:text-zinc-300">
                        Also delete output files from S3 (objects under this session’s prefix).
                    </span>
                </label>

                <div class="mt-6 flex flex-wrap justify-end gap-2">
                    <button
                        type="button"
                        class="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800 cursor-pointer disabled:cursor-not-allowed"
                        :disabled="loading"
                        @click="close"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed"
                        :disabled="loading"
                        @click="onConfirm"
                    >
                        {{ loading ? 'Deleting…' : 'Delete session' }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>
