<script setup lang="ts">
const props = withDefaults(defineProps<{
    label: string;
    progress?: number | null;
    indeterminate?: boolean;
    subtitle?: string;
}>(), {
    progress: null,
    indeterminate: false,
    subtitle: undefined,
});
</script>

<template>
    <div class="space-y-2">
        <div class="flex items-center justify-between text-sm">
            <span class="text-slate-500 dark:text-slate-400">{{ label }}</span>
            <span v-if="subtitle" class="text-xs text-slate-500 dark:text-slate-500">{{ subtitle }}</span>
            <span v-else-if="progress != null && !indeterminate" class="font-mono text-sky-700 dark:text-sky-300/90">{{ progress }}%</span>
        </div>
        <div class="h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
            <div
                v-if="indeterminate"
                class="h-full rounded-full bg-sky-500/90 animate-pulse dark:bg-sky-500/80"
                style="width: 100%"
            />
            <div
                v-else
                class="h-full rounded-full bg-sky-500 transition-all duration-300 dark:bg-sky-500"
                :style="{ width: `${progress ?? 0}%` }"
            />
        </div>
    </div>
</template>
