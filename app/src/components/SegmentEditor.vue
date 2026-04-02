<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { TrimSegment } from '@luminary-media-converter/encode-config';

const props = defineProps<{
    duration: number;
    modelValue: TrimSegment[];
    getCurrentTime: () => number;
}>();

const emit = defineEmits<{
    'update:modelValue': [segments: TrimSegment[]];
}>();

const selectedIndex = ref<number | null>(null);
const pendingIn = ref<number | null>(null);
const playheadPercent = ref(0);

// Track playhead position
let rafId = 0;
function updatePlayhead() {
    playheadPercent.value = props.duration > 0
        ? (props.getCurrentTime() / props.duration) * 100
        : 0;
    rafId = requestAnimationFrame(updatePlayhead);
}

import { onMounted, onUnmounted } from 'vue';
onMounted(() => { rafId = requestAnimationFrame(updatePlayhead); });
onUnmounted(() => cancelAnimationFrame(rafId));

const totalSelectedDuration = computed(() => {
    return props.modelValue.reduce((sum, s) => sum + (s.outSec - s.inSec), 0);
});

function formatTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
    }
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

function formatDuration(sec: number): string {
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}m ${s.toFixed(0)}s`;
}

function parseTime(str: string): number | null {
    const parts = str.trim().split(':');
    if (parts.length < 2 || parts.length > 3) return null;
    let hours = 0, minutes: number, seconds: number;
    if (parts.length === 3) {
        hours = parseInt(parts[0], 10);
        minutes = parseInt(parts[1], 10);
        seconds = parseFloat(parts[2]);
    } else {
        minutes = parseInt(parts[0], 10);
        seconds = parseFloat(parts[1]);
    }
    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
    return hours * 3600 + minutes * 60 + seconds;
}

function markIn() {
    const time = props.getCurrentTime();
    pendingIn.value = time;
    // If there's an existing selected segment, update its in-point
    if (selectedIndex.value !== null && selectedIndex.value < props.modelValue.length) {
        const segments = [...props.modelValue];
        const seg = { ...segments[selectedIndex.value] };
        seg.inSec = time;
        if (seg.outSec <= seg.inSec) seg.outSec = Math.min(seg.inSec + 1, props.duration);
        segments[selectedIndex.value] = seg;
        emitSorted(segments);
    }
}

function markOut() {
    const time = props.getCurrentTime();
    if (pendingIn.value !== null && selectedIndex.value === null) {
        // Create new segment from pending in to current time
        const inSec = Math.min(pendingIn.value, time);
        const outSec = Math.max(pendingIn.value, time);
        if (outSec - inSec < 0.5) return; // Too short
        const segments = [...props.modelValue, { inSec, outSec }];
        pendingIn.value = null;
        emitSorted(segments);
        selectedIndex.value = segments.length - 1;
    } else if (selectedIndex.value !== null && selectedIndex.value < props.modelValue.length) {
        // Update out-point of selected segment
        const segments = [...props.modelValue];
        const seg = { ...segments[selectedIndex.value] };
        seg.outSec = time;
        if (seg.outSec <= seg.inSec) seg.inSec = Math.max(seg.outSec - 1, 0);
        segments[selectedIndex.value] = seg;
        emitSorted(segments);
    }
}

function addSegment() {
    const time = props.getCurrentTime();
    const inSec = time;
    const outSec = Math.min(time + 10, props.duration);
    if (outSec - inSec < 0.5) return;
    const segments = [...props.modelValue, { inSec, outSec }];
    emitSorted(segments);
    selectedIndex.value = segments.length - 1;
}

function removeSegment(index: number) {
    const segments = props.modelValue.filter((_, i) => i !== index);
    emit('update:modelValue', segments);
    if (selectedIndex.value === index) selectedIndex.value = null;
    else if (selectedIndex.value !== null && selectedIndex.value > index) selectedIndex.value--;
}

function clearAll() {
    emit('update:modelValue', []);
    selectedIndex.value = null;
    pendingIn.value = null;
}

function emitSorted(segments: TrimSegment[]) {
    segments.sort((a, b) => a.inSec - b.inSec);
    emit('update:modelValue', segments);
}

function updateSegmentTime(index: number, field: 'inSec' | 'outSec', value: string) {
    const time = parseTime(value);
    if (time === null || time < 0 || time > props.duration) return;
    const segments = [...props.modelValue];
    const seg = { ...segments[index] };
    seg[field] = time;
    if (seg.outSec <= seg.inSec) return; // Invalid
    segments[index] = seg;
    emitSorted(segments);
}

// Check for overlaps
const hasOverlap = computed(() => {
    const sorted = [...props.modelValue].sort((a, b) => a.inSec - b.inSec);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].inSec < sorted[i - 1].outSec) return true;
    }
    return false;
});

// Drag state
const dragging = ref<{ index: number; field: 'inSec' | 'outSec' } | null>(null);
const timelineRef = ref<HTMLDivElement | null>(null);

function onTimelineClick(e: MouseEvent) {
    if (dragging.value) return;
    if (!timelineRef.value) return;
    const rect = timelineRef.value.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const _time = percent * props.duration;
    // Deselect if clicking empty area
    selectedIndex.value = null;
}

function startDrag(index: number, field: 'inSec' | 'outSec', e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    dragging.value = { index, field };
    selectedIndex.value = index;

    const onMove = (ev: MouseEvent) => {
        if (!dragging.value || !timelineRef.value) return;
        const rect = timelineRef.value.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const time = Math.round(percent * props.duration * 1000) / 1000;

        const segments = [...props.modelValue];
        const seg = { ...segments[dragging.value.index] };
        seg[dragging.value.field] = time;
        if (seg.outSec - seg.inSec < 0.5) return; // Don't allow too-short segments
        segments[dragging.value.index] = seg;
        emitSorted(segments);
    };

    const onUp = () => {
        dragging.value = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// Watch for external changes to selectedIndex
watch(() => props.modelValue.length, () => {
    if (selectedIndex.value !== null && selectedIndex.value >= props.modelValue.length) {
        selectedIndex.value = null;
    }
});
</script>

<template>
    <div class="mb-4 rounded-lg border border-zinc-700/50 bg-zinc-900/50 p-4">
        <div class="mb-3 flex items-center justify-between">
            <h3 class="text-sm font-medium text-zinc-300">Trim Segments</h3>
            <div class="flex items-center gap-2 text-xs text-zinc-500">
                <span v-if="modelValue.length > 0">
                    {{ modelValue.length }} segment{{ modelValue.length !== 1 ? 's' : '' }}
                    &middot; {{ formatDuration(totalSelectedDuration) }}
                </span>
                <span v-else>No segments (full file will be encoded)</span>
            </div>
        </div>

        <!-- Toolbar -->
        <div class="mb-3 flex flex-wrap items-center gap-2">
            <button
                type="button"
                class="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 cursor-pointer"
                title="Set in-point at current playback position"
                @click="markIn"
            >
                Mark In [
            </button>
            <button
                type="button"
                class="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 cursor-pointer"
                title="Set out-point at current playback position"
                @click="markOut"
            >
                Mark Out ]
            </button>
            <button
                type="button"
                class="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-zinc-100 cursor-pointer"
                title="Add a 10-second segment at the current position"
                @click="addSegment"
            >
                + Add Segment
            </button>
            <button
                v-if="modelValue.length > 0"
                type="button"
                class="rounded border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs font-medium text-red-400 transition-colors hover:bg-red-950/30 hover:text-red-300 cursor-pointer"
                @click="clearAll"
            >
                Clear All
            </button>
            <span v-if="pendingIn !== null" class="text-xs text-amber-400">
                In: {{ formatTime(pendingIn) }} — click "Mark Out" to create segment
            </span>
        </div>

        <!-- Timeline bar -->
        <div
            ref="timelineRef"
            class="relative mb-3 h-8 cursor-crosshair overflow-hidden rounded bg-zinc-800"
            @click="onTimelineClick"
        >
            <!-- Segment overlays -->
            <div
                v-for="(seg, i) in modelValue"
                :key="i"
                class="absolute top-0 h-full transition-colors"
                :class="[
                    selectedIndex === i ? 'bg-indigo-500/50 border-y border-indigo-400' : 'bg-indigo-500/30',
                    hasOverlap ? 'bg-red-500/30' : ''
                ]"
                :style="{
                    left: `${(seg.inSec / duration) * 100}%`,
                    width: `${((seg.outSec - seg.inSec) / duration) * 100}%`,
                }"
                @click.stop="selectedIndex = i"
            >
                <!-- In-point drag handle -->
                <div
                    class="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize bg-indigo-400 opacity-60 hover:opacity-100"
                    @mousedown="startDrag(i, 'inSec', $event)"
                />
                <!-- Out-point drag handle -->
                <div
                    class="absolute right-0 top-0 h-full w-1.5 cursor-ew-resize bg-indigo-400 opacity-60 hover:opacity-100"
                    @mousedown="startDrag(i, 'outSec', $event)"
                />
                <!-- Segment label -->
                <span
                    v-if="((seg.outSec - seg.inSec) / duration) * 100 > 5"
                    class="absolute inset-0 flex items-center justify-center text-[10px] font-medium text-white/70 pointer-events-none"
                >
                    {{ i + 1 }}
                </span>
            </div>

            <!-- Playhead -->
            <div
                class="absolute top-0 h-full w-0.5 bg-white/70 pointer-events-none"
                :style="{ left: `${playheadPercent}%` }"
            />

            <!-- Time markers -->
            <div class="absolute bottom-0 left-1 text-[9px] text-zinc-500 pointer-events-none">0:00</div>
            <div class="absolute bottom-0 right-1 text-[9px] text-zinc-500 pointer-events-none">{{ formatTime(duration) }}</div>
        </div>

        <!-- Segment list -->
        <div v-if="modelValue.length > 0" class="space-y-1">
            <div
                v-for="(seg, i) in modelValue"
                :key="i"
                class="flex items-center gap-2 rounded px-2 py-1 text-xs transition-colors cursor-pointer"
                :class="selectedIndex === i ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'"
                @click="selectedIndex = i"
            >
                <span class="w-5 text-center font-medium text-zinc-500">{{ i + 1 }}</span>
                <input
                    type="text"
                    :value="formatTime(seg.inSec)"
                    class="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-center font-mono text-zinc-300 focus:border-indigo-500 focus:outline-none"
                    @change="updateSegmentTime(i, 'inSec', ($event.target as HTMLInputElement).value)"
                    @click.stop
                />
                <span class="text-zinc-600">-</span>
                <input
                    type="text"
                    :value="formatTime(seg.outSec)"
                    class="w-24 rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-center font-mono text-zinc-300 focus:border-indigo-500 focus:outline-none"
                    @change="updateSegmentTime(i, 'outSec', ($event.target as HTMLInputElement).value)"
                    @click.stop
                />
                <span class="text-zinc-500">{{ formatDuration(seg.outSec - seg.inSec) }}</span>
                <button
                    type="button"
                    class="ml-auto text-zinc-600 transition-colors hover:text-red-400 cursor-pointer"
                    title="Remove segment"
                    @click.stop="removeSegment(i)"
                >
                    <svg class="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </button>
            </div>
        </div>

        <!-- Overlap warning -->
        <div v-if="hasOverlap" class="mt-2 text-xs text-red-400">
            Segments overlap — please adjust the in/out points.
        </div>
    </div>
</template>
