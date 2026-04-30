<script setup lang="ts">
import { useTheme, type ThemePreference } from '../composables/useTheme';

const { preference, setPreference } = useTheme();

const options: { value: ThemePreference; label: string; title: string }[] = [
    { value: 'light', label: 'Light', title: 'Light theme' },
    { value: 'system', label: 'Auto', title: 'Match system' },
    { value: 'dark', label: 'Dark', title: 'Dark theme' },
];
</script>

<template>
    <div
        class="inline-flex rounded-lg border border-zinc-200 bg-zinc-100/80 p-0.5 dark:border-zinc-700 dark:bg-zinc-900/80"
        role="group"
        aria-label="Theme"
    >
        <button
            v-for="opt in options"
            :key="opt.value"
            type="button"
            :title="opt.title"
            :class="[
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                preference === opt.value
                    ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100'
                    : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            ]"
            :aria-pressed="preference === opt.value"
            @click="setPreference(opt.value)"
        >
            {{ opt.label }}
        </button>
    </div>
</template>
