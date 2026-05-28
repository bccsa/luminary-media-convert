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
    <div class="space-y-1.5">
        <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-medium text-slate-600 dark:text-slate-300">{{ label }}</span>
            <span v-if="subtitle" class="text-[11px] text-slate-400 dark:text-slate-500">{{ subtitle }}</span>
            <span
                v-else-if="progress != null && !indeterminate"
                class="shrink-0 font-mono text-[11px] tabular-nums"
                :class="progress >= 100
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-sky-600 dark:text-sky-400'"
            >{{ progress }}%</span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
                v-if="indeterminate"
                class="progress-bar-indeterminate h-full w-full rounded-full bg-linear-to-r from-sky-400 via-sky-500 to-sky-400"
            />
            <div
                v-else
                class="relative h-full overflow-hidden rounded-full transition-all duration-500 ease-out"
                :class="progress != null && progress >= 100
                    ? 'bg-emerald-500 dark:bg-emerald-500'
                    : 'bg-linear-to-r from-sky-500 to-sky-400'"
                :style="{ width: `${progress ?? 0}%` }"
            >
                <div
                    v-if="progress != null && progress > 0 && progress < 100"
                    class="progress-bar-shimmer absolute inset-0"
                />
            </div>
        </div>
    </div>
</template>

<style scoped>
@keyframes shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(200%); }
}
@keyframes indeterminate {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
}

.progress-bar-shimmer {
    background: linear-gradient(
        90deg,
        transparent 0%,
        rgba(255,255,255,0.28) 50%,
        transparent 100%
    );
    animation: shimmer 1.8s ease-in-out infinite;
}

.progress-bar-indeterminate {
    animation: indeterminate 1.4s ease-in-out infinite;
}
</style>
