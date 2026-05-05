<script setup lang="ts">
import { computed } from 'vue';

export type StepVisual = 'pending' | 'active' | 'done' | 'error';

type StepKey = 'ingest' | 'probe' | 'encoding' | 'upload' | 'finalize';

const props = defineProps<{
    ingest: StepVisual;
    probe: StepVisual;
    encoding: StepVisual;
    upload: StepVisual;
    finalize: StepVisual;
}>();

const STEPS: { key: StepKey; label: string }[] = [
    { key: 'ingest', label: 'Ingest' },
    { key: 'probe', label: 'Probe' },
    { key: 'encoding', label: 'Encoding' },
    { key: 'upload', label: 'Upload' },
    { key: 'finalize', label: 'Finalize' },
];

function circleClass(v: StepVisual): string {
    const base = 'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold';
    switch (v) {
        case 'done':
            return `${base} bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400`;
        case 'active':
            return `${base} bg-indigo-100 text-indigo-700 ring-2 ring-indigo-400/60 dark:bg-indigo-500/20 dark:text-indigo-300 dark:ring-indigo-400/40`;
        case 'error':
            return `${base} bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-400`;
        default:
            return `${base} bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-500`;
    }
}

const stepsWithVisual = computed(() =>
    STEPS.map((s) => ({ ...s, visual: props[s.key] })),
);
</script>

<template>
    <nav aria-label="Encoding pipeline progress" class="overflow-x-auto pb-1">
        <ol class="flex min-w-max items-start gap-2 sm:gap-4">
            <li v-for="(step, i) in stepsWithVisual" :key="step.key" class="flex items-start gap-1 sm:gap-3">
                <div class="flex flex-col items-center">
                    <span :class="circleClass(step.visual)">
                        <svg
                            v-if="step.visual === 'done'"
                            class="h-4 w-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2.5"
                        >
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                        <svg
                            v-else-if="step.visual === 'active'"
                            class="h-4 w-4 animate-spin"
                            fill="none"
                            viewBox="0 0 24 24"
                        >
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                            <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span v-else-if="step.visual === 'error'">!</span>
                        <span v-else class="text-[11px] text-zinc-500">{{ i + 1 }}</span>
                    </span>
                    <span
                        class="mt-1.5 max-w-[4.5rem] text-center text-[10px] font-medium uppercase tracking-wide sm:max-w-none sm:text-xs"
                        :class="step.visual === 'active'
                            ? 'text-indigo-700 dark:text-indigo-300'
                            : step.visual === 'done'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : step.visual === 'error'
                                ? 'text-red-700 dark:text-red-400'
                                : 'text-zinc-500 dark:text-zinc-500'"
                    >
                        {{ step.label }}
                    </span>
                </div>
                <div
                    v-if="i < stepsWithVisual.length - 1"
                    class="mx-0.5 mt-4 hidden h-px w-4 shrink-0 bg-zinc-200 sm:block sm:w-6 dark:bg-zinc-700"
                    aria-hidden="true"
                />
            </li>
        </ol>
    </nav>
</template>
