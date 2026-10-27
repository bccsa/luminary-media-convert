<script setup lang="ts">
/**
 * The portrait scrub: the full-screen roster (`RosterView` in `SkinControls.kt`, which is the skin's own
 * strip), over the picture. The page's slider opens it (the fast way); dragging it slides the strip under
 * the fixed marker (the slow way). It stays up until a press lands outside both the roster and the slider
 * (anything carrying `data-scrub`). The seek happens on release, as in full screen.
 *
 * Drawn by the page over the see-through inline video, from the controller's own `thumbnailAt`, so it
 * is the same on native and web and the bridge needs nothing new.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ThumbnailSpriteCue } from '@luminary-media-converter/player-core';
import { formatClock, rosterStep, rosterTiles } from './scrubPreview';

const props = defineProps<{
    /** The time under the marker, in seconds. */
    time: number;
    duration: number;
    thumbnailAt: (seconds: number) => ThumbnailSpriteCue | null;
}>();
const emit = defineEmits<{ 'update:time': [seconds: number]; commit: [seconds: number]; close: [] }>();

const root = ref<HTMLElement | null>(null);
const width = ref(0);

/** The frame the web's hover preview shows: a sixth of the width, 16:9, as in full screen. */
const height = computed(() => (Math.min(340, Math.max(168, width.value / 6)) * 9) / 16);
/** Every frame of an encode shares one crop shape. */
const sample = computed(() => props.thumbnailAt(0));
const tileWidth = computed(() => {
    const cue = sample.value;
    return Math.max(24, cue && cue.w && cue.h ? (height.value * cue.w) / cue.h : (height.value * 16) / 9);
});
const step = computed(() => rosterStep(props.duration));
const pxPerSecond = computed(() => tileWidth.value / step.value);
const tiles = computed(() =>
    rosterTiles(props.time, width.value / 2, width.value, tileWidth.value, step.value, props.duration).map((tile) => ({
        ...tile,
        cue: props.thumbnailAt(tile.time),
    })),
);

/** The crop of a sheet, stretched to the tile as the skin's `drawBitmap(src, dst)` does. */
function frameStyle(cue: ThumbnailSpriteCue | null): Record<string, string> {
    if (!cue || !cue.w || !cue.h) return {};
    return {
        width: `${cue.w}px`,
        height: `${cue.h}px`,
        backgroundImage: `url("${cue.spriteUrl}")`,
        backgroundPosition: `-${cue.x}px -${cue.y}px`,
        backgroundRepeat: 'no-repeat',
        transform: `scale(${tileWidth.value / cue.w}, ${height.value / cue.h})`,
        transformOrigin: 'top left',
    };
}

// The slow way: the strip follows the finger, so dragging left moves forward in time.
let drag: { x: number; time: number } | null = null;
const clamp = (seconds: number) => Math.min(Math.max(seconds, 0), props.duration);
function down(event: PointerEvent): void {
    drag = { x: event.clientX, time: props.time };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}
function move(event: PointerEvent): void {
    if (drag) emit('update:time', clamp(drag.time - (event.clientX - drag.x) / pxPerSecond.value));
}
function up(): void {
    if (!drag) return;
    drag = null;
    emit('commit', props.time);
}

function outside(event: PointerEvent): void {
    if (!(event.target as Element | null)?.closest('[data-scrub]')) emit('close');
}
let observer: ResizeObserver | undefined;
onMounted(() => {
    window.addEventListener('pointerdown', outside, true);
    observer = new ResizeObserver(() => (width.value = root.value?.clientWidth ?? 0));
    if (root.value) observer.observe(root.value);
    width.value = root.value?.clientWidth ?? 0;
});
onBeforeUnmount(() => {
    window.removeEventListener('pointerdown', outside, true);
    observer?.disconnect();
});
</script>

<template>
    <div ref="root" class="roster-host">
        <div class="roster__label" :style="{ bottom: `${height + 8}px` }">{{ formatClock(time, duration >= 3600) }}</div>
        <div class="roster" data-scrub :style="{ height: `${height}px` }" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up">
            <div v-for="tile in tiles" :key="tile.index" class="roster__tile" :style="{ left: `${tile.left}px`, width: `${tileWidth}px` }">
                <div :style="frameStyle(tile.cue)"></div>
            </div>
            <div class="roster__fade-x"></div>
            <div class="roster__fade-y"></div>
            <div class="roster__marker"></div>
        </div>
    </div>
</template>

<style scoped>
.roster-host {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    animation: roster-in 200ms ease-out;
}
@keyframes roster-in {
    from {
        opacity: 0;
        transform: translateY(6px);
    }
}
.roster {
    position: relative;
    overflow: hidden;
    background: #0b0b0d;
    touch-action: none;
    user-select: none;
}
.roster__tile {
    position: absolute;
    top: 0;
    bottom: 0;
    overflow: hidden;
    background: #151518;
}
/* A frame apart from its neighbour, without a gutter. */
.roster__tile::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    width: 1px;
    background: rgba(0, 0, 0, 0.55);
}
/* The frames nearest the marker are the ones that matter: the rest fall away. */
.roster__fade-x,
.roster__fade-y {
    position: absolute;
    inset: 0;
    pointer-events: none;
}
.roster__fade-x {
    background: linear-gradient(
        to right,
        rgba(8, 10, 10, 0.78) 0%,
        rgba(8, 10, 10, 0.35) 28%,
        rgba(8, 10, 10, 0) 42%,
        rgba(8, 10, 10, 0) 58%,
        rgba(8, 10, 10, 0.35) 72%,
        rgba(8, 10, 10, 0.78) 100%
    );
}
.roster__fade-y {
    background: linear-gradient(to bottom, rgba(0, 0, 0, 0.28) 0%, rgba(0, 0, 0, 0) 35%, rgba(0, 0, 0, 0) 70%, rgba(0, 0, 0, 0.4) 100%);
    /* A hairline of light where the timeline rests on the strip. */
    box-shadow: inset 0 1px rgba(255, 255, 255, 0.14);
}
/* A rounded white bar with an outline and a glow. */
.roster__marker {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 50%;
    width: 3px;
    margin-left: -1.5px;
    border-radius: 3px;
    background: #fff;
    box-shadow:
        0 0 0 1px rgba(0, 0, 0, 0.4),
        0 0 14px rgba(255, 255, 255, 0.55);
    pointer-events: none;
}
.roster__label {
    position: absolute;
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 11px;
    border-radius: 40px;
    background: rgba(20, 20, 24, 0.72);
    color: #fff;
    font: 500 14px/1.2 sans-serif;
    pointer-events: none;
}
</style>
