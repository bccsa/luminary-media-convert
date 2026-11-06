<script setup lang="ts">
/**
 * One language's subtitle lines as a track above the timeline strip, sharing its
 * zoom and pan, edited the way chapters are: `[` and `]` at the playhead, a
 * double-press and drag to draw a line, drags to move and retime, Delete, and
 * undo. A click on a line picks it and plays from it. Away from its tab a click
 * only plays, and an edit asks for the Subtitles tab first, where its Save is.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import { createSegmentId, type Segment, type SegmentKeyTarget } from '../segment-editor';

const props = defineProps<{
    duration: number;
    /** The strip's window on the video, in seconds. */
    viewStart: number;
    visibleSpan: number;
    playheadSec: number;
    getCurrentTime: () => number;
    /** The language's name, shown at the track's end. */
    name: string;
    /** Away from the Subtitles tab: an edit emits `edit` so the host can bring that tab up. */
    away?: boolean;
    onSeek?: (seconds: number) => void;
}>();

const emit = defineEmits<{
    /** A mouse edit began while away from the Subtitles tab. */
    edit: [];
}>();

const lines = defineModel<Segment[]>({ required: true });
const selected = defineModel<string | null>('selected', { default: null });

/** Shortest a line can be. */
const MIN_SEC = 0.2;
/** How long a line `]` makes with no `[` before it. */
const OUT_ONLY_SEC = 2;

const lane = ref<HTMLElement | null>(null);
const pending = ref<number | null>(null);
/** The line being drawn with a double-press and drag. */
const drawing = ref<{ inSec: number; outSec: number } | null>(null);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ms = (v: number) => Math.round(v * 1000) / 1000;
const pct = (sec: number) => ((sec - props.viewStart) / props.visibleSpan) * 100;
const inView = (sec: number) => sec >= props.viewStart && sec <= props.viewStart + props.visibleSpan;

const sorted = computed(() => [...lines.value].sort((a, b) => a.inSec - b.inSec));
const visible = computed(() => {
    const end = props.viewStart + props.visibleSpan;
    return sorted.value.filter((l) => l.outSec > props.viewStart && l.inSec < end);
});

// ---- History ---------------------------------------------------------------
// Each step is one line before and after, so undo reverses only what the track
// did and leaves the words typed in the list since then alone.

type Step = { before: Segment | null; after: Segment | null };
const undoStack: Step[] = [];
const redoStack: Step[] = [];

/** Puts a line back as `to` (null: takes it out), keeping the words it has now. */
function apply(id: string, to: Segment | null): void {
    if (!to) {
        lines.value = lines.value.filter((l) => l.id !== id);
        if (selected.value === id) selected.value = null;
        return;
    }
    const now = lines.value.find((l) => l.id === id);
    lines.value = now
        ? lines.value.map((l) => (l.id === id ? { ...l, inSec: to.inSec, outSec: to.outSec } : l))
        : [...lines.value, { ...to }];
    selected.value = id;
}

function record(before: Segment | null, after: Segment | null): void {
    undoStack.push({ before: before && { ...before }, after: after && { ...after } });
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
}

function undo(): void {
    const step = undoStack.pop();
    if (!step) return;
    redoStack.push(step);
    apply((step.before ?? step.after)!.id, step.before);
}

function redo(): void {
    const step = redoStack.pop();
    if (!step) return;
    undoStack.push(step);
    apply((step.after ?? step.before)!.id, step.after);
}

/** Retimes a line; returns it as it now is, since the model comes back from the parent a tick later. */
function change(id: string, inSec: number, outSec: number, opts: { record?: boolean } = {}): Segment | undefined {
    const before = lines.value.find((l) => l.id === id);
    if (!before) return undefined;
    const after = { ...before, inSec: ms(inSec), outSec: ms(outSec) };
    lines.value = lines.value.map((l) => (l.id === id ? after : l));
    if (opts.record !== false) record(before, after);
    return after;
}

function add(inSec: number, outSec: number): void {
    const line: Segment = { id: createSegmentId(), inSec: ms(inSec), outSec: ms(outSec), label: '' };
    lines.value = [...lines.value, line];
    record(null, line);
    // Opens in the list, but the keyboard stays here for the next line.
    selected.value = line.id;
}

// ---- Keys, handed over by the timeline -----------------------------------

const lineAt = (t: number) => sorted.value.find((l) => l.inSec <= t && t < l.outSec);
const now = () => clamp(props.getCurrentTime(), 0, props.duration);

/** In a line, moves its start here; elsewhere, starts a new line here. */
function markIn(): void {
    const t = now();
    const at = lineAt(t);
    if (at) {
        change(at.id, t, Math.max(at.outSec, t + MIN_SEC));
        pending.value = null;
        return;
    }
    pending.value = t;
}

/** In a line, moves its end here; after a `[`, makes the line between the two; alone, a short line up to here. */
function markOut(): void {
    const t = now();
    const at = lineAt(t);
    if (at) {
        change(at.id, Math.max(0, Math.min(at.inSec, t - MIN_SEC)), t);
        pending.value = null;
        return;
    }
    if (pending.value !== null) {
        const [inSec, outSec] = [Math.min(pending.value, t), Math.max(pending.value, t)];
        pending.value = null;
        if (outSec - inSec >= MIN_SEC) add(inSec, outSec);
        return;
    }
    const previousEnd = sorted.value.filter((l) => l.outSec <= t).at(-1)?.outSec ?? 0;
    const inSec = Math.max(previousEnd, t - OUT_ONLY_SEC);
    if (t - inSec >= MIN_SEC) add(inSec, t);
}

function removeSelected(): boolean {
    const line = lines.value.find((l) => l.id === selected.value);
    if (!line) return false;
    lines.value = lines.value.filter((l) => l.id !== line.id);
    record(line, null);
    selected.value = null;
    return true;
}

defineExpose<SegmentKeyTarget>({ markIn, markOut, removeSelected, undo, redo, escape: () => (pending.value = null) });

// ---- Pointer -------------------------------------------------------------

type Drag =
    | { kind: 'move' | 'inSec' | 'outSec'; line: Segment; startX: number; moved: boolean; last?: Segment }
    | { kind: 'scrub'; anchor: number }
    | { kind: 'draw'; anchor: number };
let drag: Drag | null = null;

const timeAt = (clientX: number) => {
    const rect = lane.value!.getBoundingClientRect();
    return clamp(props.viewStart + ((clientX - rect.left) / rect.width) * props.visibleSpan, 0, props.duration);
};

function onMove(e: PointerEvent): void {
    const d = drag;
    if (!d) return;
    if (d.kind === 'scrub') {
        props.onSeek?.(timeAt(e.clientX));
        return;
    }
    if (d.kind === 'draw') {
        const t = timeAt(e.clientX);
        drawing.value = { inSec: Math.min(d.anchor, t), outSec: Math.max(d.anchor, t) };
        return;
    }
    if (!d.moved && Math.abs(e.clientX - d.startX) < 3) return;
    if (!d.moved && props.away) {
        selected.value = d.line.id;
        emit('edit');
    }
    d.moved = true;
    const shift = ((e.clientX - d.startX) / lane.value!.getBoundingClientRect().width) * props.visibleSpan;
    const { inSec, outSec, id } = d.line;
    if (d.kind === 'move') {
        const start = clamp(inSec + shift, 0, Math.max(0, props.duration - (outSec - inSec)));
        d.last = change(id, start, start + (outSec - inSec), { record: false });
    } else if (d.kind === 'inSec') d.last = change(id, clamp(inSec + shift, 0, outSec - MIN_SEC), outSec, { record: false });
    else d.last = change(id, inSec, clamp(outSec + shift, inSec + MIN_SEC, props.duration), { record: false });
}

function onUp(): void {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const done = drag;
    drag = null;
    if (!done) return;
    if (done.kind === 'draw') {
        const range = drawing.value;
        drawing.value = null;
        if (range && range.outSec - range.inSec >= MIN_SEC) add(range.inSec, range.outSec);
        return;
    }
    if (done.kind === 'scrub') return;
    if (done.moved) {
        if (done.last) record(done.line, done.last);
    } else if (done.kind === 'move') props.onSeek?.(done.line.inSec); // A click plays from the line.
}

function listen(): void {
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
}

function startDrag(e: PointerEvent, line: Segment, kind: 'move' | 'inSec' | 'outSec'): void {
    if (e.button !== 0 || !lane.value) return;
    e.preventDefault();
    e.stopPropagation();
    if (props.away && kind !== 'move') emit('edit');
    // Away, a line is picked only once it is edited: a click there just plays from it.
    if (!props.away || kind !== 'move') selected.value = line.id;
    drag = { kind, line: { ...line }, startX: e.clientX, moved: false };
    listen();
}

/** How close together, in time and space, two presses count as one gesture: the same as the timeline's. */
const DOUBLE_PRESS_MS = 350;
const DOUBLE_PRESS_SLOP_PX = 5;
let lastPress: { at: number; x: number } | null = null;

/** Between lines: a press and drag scrubs, a double-press and drag draws a new line. */
function onLaneDown(e: PointerEvent): void {
    if (e.button !== 0 || !lane.value) return;
    e.preventDefault();
    const t = timeAt(e.clientX);
    const second =
        lastPress && performance.now() - lastPress.at <= DOUBLE_PRESS_MS && Math.abs(e.clientX - lastPress.x) <= DOUBLE_PRESS_SLOP_PX;
    if (second) {
        if (props.away) emit('edit');
        lastPress = null;
        drag = { kind: 'draw', anchor: t };
        drawing.value = { inSec: t, outSec: t };
    } else {
        lastPress = { at: performance.now(), x: e.clientX };
        drag = { kind: 'scrub', anchor: t };
        props.onSeek?.(t);
    }
    listen();
}

onBeforeUnmount(onUp);
</script>

<template>
    <div
        ref="lane"
        class="relative mb-1 h-7 cursor-crosshair overflow-hidden rounded-md bg-slate-100 select-none dark:bg-blue-950/70"
        role="group"
        :aria-label="`${name} subtitles`"
        data-test="subtitleTrack"
        @pointerdown="onLaneDown"
    >
        <span
            class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[10px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500"
            aria-hidden="true"
            >{{ name }}</span
        >
        <div
            v-for="line in visible"
            :key="line.id"
            class="group absolute top-0.5 bottom-0.5 flex items-center overflow-hidden rounded border px-1.5"
            :class="[
                'cursor-grab active:cursor-grabbing',
                line.id === selected && !away
                    ? 'z-[2] border-amber-700 bg-amber-400 text-amber-950 dark:border-amber-300 dark:bg-amber-400/80'
                    : 'z-[1] border-amber-500/70 bg-amber-200/90 text-amber-950 hover:bg-amber-300 dark:border-amber-400/50 dark:bg-amber-400/25 dark:text-amber-100',
            ]"
            :style="{ left: `${pct(line.inSec)}%`, width: `${((line.outSec - line.inSec) / visibleSpan) * 100}%` }"
            :title="line.label || undefined"
            :aria-current="line.id === selected ? 'true' : undefined"
            data-test="subtitleTrackLine"
            @pointerdown="startDrag($event, line, 'move')"
        >
            <span class="pointer-events-none truncate text-[10px] leading-none font-medium">{{ line.label }}</span>
            <span
                class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize hover:bg-amber-700/40"
                aria-hidden="true"
                data-test="subtitleTrackIn"
                @pointerdown="startDrag($event, line, 'inSec')"
            ></span>
            <span
                class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize hover:bg-amber-700/40"
                aria-hidden="true"
                data-test="subtitleTrackOut"
                @pointerdown="startDrag($event, line, 'outSec')"
            ></span>
        </div>
        <span
            v-if="drawing"
            class="pointer-events-none absolute inset-y-0.5 z-[3] rounded border border-dashed border-amber-600 bg-amber-300/50"
            :style="{ left: `${pct(drawing.inSec)}%`, width: `${((drawing.outSec - drawing.inSec) / visibleSpan) * 100}%` }"
            aria-hidden="true"
            data-test="subtitleTrackDrawing"
        ></span>
        <span
            v-if="pending !== null && inView(pending)"
            class="pointer-events-none absolute inset-y-0 z-[3] w-0.5 bg-amber-700 dark:bg-amber-400"
            :style="{ left: `${pct(pending)}%` }"
            aria-hidden="true"
            data-test="subtitleTrackPending"
        ></span>
        <span
            v-if="inView(playheadSec)"
            class="pointer-events-none absolute inset-y-0 z-[3] w-0.5 bg-sky-700 dark:bg-white/95"
            :style="{ left: `${pct(playheadSec)}%` }"
            aria-hidden="true"
        ></span>
    </div>
</template>
