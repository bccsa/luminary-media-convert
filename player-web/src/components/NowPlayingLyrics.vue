<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { activeLyric, type LyricCue } from '../ui/lyrics';

/**
 * The words of what plays, in the picture's place on the now-playing screen: the line being sung large and bright,
 * the rest dim, the list keeping that line in the middle as the audio goes. A tap on a line goes there.
 */
const props = defineProps<{
    lines: readonly LyricCue[];
    currentTime: number;
    label: string;
}>();

const emit = defineEmits<{ seek: [time: number] }>();

const listEl = ref<HTMLElement | null>(null);
const active = computed(() => activeLyric(props.lines, props.currentTime));

/** A viewer reading ahead or back is left there for a while before the list follows the audio again. */
const HANDS_OFF_MS = 4000;
let touchedAt = -Infinity;
const touched = (): void => {
    touchedAt = performance.now();
};

function follow(smooth: boolean): void {
    const list = listEl.value;
    const line = list?.querySelectorAll<HTMLElement>('[data-lyric]')[active.value];
    if (!list || !line) return;
    if (performance.now() - touchedAt < HANDS_OFF_MS) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top = line.offsetTop - list.clientHeight / 2 + line.offsetHeight / 2;
    list.scrollTo?.({ top: Math.max(0, top), behavior: smooth && !reduce ? 'smooth' : 'auto' });
}

watch(active, async () => {
    await nextTick();
    follow(true);
});
watch(
    () => props.lines,
    async () => {
        await nextTick();
        follow(false);
    },
    { immediate: true }
);
onBeforeUnmount(() => {
    touchedAt = -Infinity;
});
</script>

<template>
    <ol
        ref="listEl"
        class="lmpl-afs-lyrics"
        :aria-label="label"
        data-test="afsLyrics"
        @wheel.passive="touched"
        @touchstart.passive="touched"
        @pointerdown="touched"
    >
        <li v-for="(line, i) in lines" :key="`${line.start}-${i}`">
            <button
                type="button"
                class="lmpl-afs-lyric"
                :class="{ 'lmpl-afs-lyric-now': i === active }"
                :aria-current="i === active ? 'true' : undefined"
                data-lyric
                @click="emit('seek', line.start)"
            >
                {{ line.text }}
            </button>
        </li>
    </ol>
</template>
