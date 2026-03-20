<script setup lang="ts">
const props = withDefaults(defineProps<{
    label: string;
    color?: string;
    borderColor?: string;
    icon?: string;
    title?: string;
}>(), {
    color: 'text-zinc-400',
    borderColor: 'border-zinc-700',
    icon: undefined,
    title: undefined,
});
</script>

<template>
    <span
        class="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium"
        :class="[borderColor, color]"
        :title="title"
    >
        <svg
            v-if="icon"
            class="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
        >
            <path :d="icon" />
        </svg>
        {{ label }}
    </span>
</template>
