<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Segment, SegmentEditorMode } from './types';
import { createSegmentId } from './types';
import { formatDuration, formatTime, parseTime } from './time';
import { exportChaptersVtt, exportSubtitlesVtt, parseVtt } from './vtt';
import './styles.css';

type KeyboardScope = 'focus' | 'global' | 'off';

interface Props {
    modelValue: Segment[];
    duration: number;
    getCurrentTime: () => number;
    onSeek?: (seconds: number) => void;
    onPlayPause?: () => void;
    isPlaying?: boolean;
    mode?: SegmentEditorMode;
    /** Override the mode-derived label visibility. */
    showLabels?: boolean;
    /** Override the mode-derived overlap policy. */
    allowOverlap?: boolean;
    /** Chapters mode only: when true, inserting/moving a segment pushes neighbors. */
    rippleEdit?: boolean;
    minSegmentSec?: number;
    /** Snap to playhead/segment edges within this distance (seconds). 0 disables snap. */
    snapSec?: number;
    /** Where keyboard shortcuts are active. */
    keyboardScope?: KeyboardScope;
    /** Maximum seek emissions per second while dragging/scrubbing. */
    throttleSeekMs?: number;
    /** Optional frame rate; enables `,` / `.` frame stepping. */
    fps?: number;
    title?: string;
    /** Show the built-in toolbar. */
    showToolbar?: boolean;
    /** Show built-in play/pause + step controls. */
    showPlaybackControls?: boolean;
    /** Show the segment list under the timeline. */
    showList?: boolean;
    /** Show the keyboard help button. */
    showHelp?: boolean;
    /** Max/min zoom (1 = fit to duration, 2 = 2× zoom, ...). */
    maxZoom?: number;
    /** Compact NLE-style hint row below playback controls (In/Out keys, jog, zoom). */
    showShortcutsStrip?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
    mode: 'trim',
    minSegmentSec: 0.2,
    snapSec: 0.25,
    keyboardScope: 'focus',
    throttleSeekMs: 33,
    fps: 0,
    title: undefined,
    showToolbar: true,
    showPlaybackControls: true,
    showList: true,
    showHelp: true,
    maxZoom: 40,
    showShortcutsStrip: true,
    isPlaying: false,
    rippleEdit: true,
    showLabels: undefined,
    allowOverlap: undefined,
});

const emit = defineEmits<{
    'update:modelValue': [segments: Segment[]];
    select: [ids: string[]];
    seek: [seconds: number];
    'segment-commit': [segments: Segment[]];
}>();

// -------------- derived mode config --------------

const labelsVisible = computed(() => props.showLabels ?? props.mode !== 'trim');
const overlapAllowed = computed(() => props.allowOverlap ?? props.mode === 'subtitles');
const modeTitle = computed(() => {
    if (props.title) return props.title;
    switch (props.mode) {
        case 'chapters': return 'Chapters';
        case 'subtitles': return 'Subtitles';
        default: return 'Trim Segments';
    }
});

// -------------- id hygiene --------------
// Ensure every incoming segment has a stable id; re-emit once with ids if the consumer omitted them.

function hydrateIds(list: Segment[]): Segment[] {
    return list.map((s) => (s.id ? s : { ...s, id: createSegmentId() }));
}

watch(
    () => props.modelValue,
    (v) => {
        if (v && v.some((s) => !s.id)) emit('update:modelValue', hydrateIds(v));
    },
    { immediate: true },
);

const segments = computed<Segment[]>(() => hydrateIds(props.modelValue ?? []));

// -------------- selection / pending --------------

const selectedIds = ref<Set<string>>(new Set());
const pendingInSec = ref<number | null>(null);

function setSelection(ids: string[]) {
    selectedIds.value = new Set(ids);
    emit('select', ids);
}
function toggleSelection(id: string) {
    const next = new Set(selectedIds.value);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selectedIds.value = next;
    emit('select', Array.from(next));
}
function clearSelection() {
    if (selectedIds.value.size === 0) return;
    selectedIds.value = new Set();
    emit('select', []);
}

const primarySelectedId = computed(() => {
    if (selectedIds.value.size === 0) return null;
    const ids = Array.from(selectedIds.value);
    // Primary = first in time order.
    return segments.value.find((s) => ids.includes(s.id))?.id ?? null;
});

// -------------- viewport / zoom --------------

const zoom = ref(1); // 1 = full duration visible
const panStartSec = ref(0);

const viewStart = computed(() => panStartSec.value);
const viewEnd = computed(() => Math.min(props.duration, panStartSec.value + visibleSpan.value));
const visibleSpan = computed(() => (props.duration > 0 ? props.duration / zoom.value : 0));

function clampPan(s: number): number {
    const maxStart = Math.max(0, props.duration - visibleSpan.value);
    return Math.max(0, Math.min(maxStart, s));
}
function setZoom(z: number, anchorSec?: number) {
    const newZoom = Math.max(1, Math.min(props.maxZoom, z));
    if (props.duration <= 0) { zoom.value = newZoom; return; }
    const anchor = anchorSec ?? (viewStart.value + visibleSpan.value / 2);
    const relative = (anchor - viewStart.value) / visibleSpan.value; // 0..1
    zoom.value = newZoom;
    const newSpan = props.duration / newZoom;
    panStartSec.value = clampPan(anchor - relative * newSpan);
}

/** Zoom and pan so the given range fills the timeline. */
function zoomTo(startSec: number, endSec: number) {
    if (props.duration <= 0 || endSec <= startSec) return;
    const span = Math.max(0.5, endSec - startSec);
    zoom.value = Math.max(1, Math.min(props.maxZoom, props.duration / span));
    panStartSec.value = clampPan(startSec);
}

// -------------- playhead --------------

const playheadSec = ref(0);
let rafId = 0;
function tick() {
    playheadSec.value = Math.max(0, Math.min(props.duration, props.getCurrentTime()));
    rafId = requestAnimationFrame(tick);
}

const playheadPercent = computed(() => {
    if (visibleSpan.value <= 0) return -1;
    const rel = (playheadSec.value - viewStart.value) / visibleSpan.value;
    return rel * 100;
});

// -------------- timeline measurement --------------

const timelineRef = ref<HTMLDivElement | null>(null);

function pxToTime(clientX: number): number {
    if (!timelineRef.value) return 0;
    const rect = timelineRef.value.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return viewStart.value + ratio * visibleSpan.value;
}

function timeToPercent(sec: number): number {
    if (visibleSpan.value <= 0) return 0;
    return ((sec - viewStart.value) / visibleSpan.value) * 100;
}

// -------------- seek throttle --------------

let lastSeekEmit = 0;
function emitSeek(sec: number, final: boolean) {
    const clamped = Math.max(0, Math.min(props.duration, sec));
    const now = performance.now();
    if (!final && now - lastSeekEmit < props.throttleSeekMs) return;
    lastSeekEmit = now;
    emit('seek', clamped);
    props.onSeek?.(clamped);
}

// -------------- timeline interaction: click-to-seek + drag-scrub + marquee --------------

type DragMode = 'scrub' | 'handle' | 'segment' | 'marquee' | null;
const dragMode = ref<DragMode>(null);
const dragContext = ref<{
    id?: string;
    field?: 'inSec' | 'outSec';
    originSec?: number;
    originIn?: number;
    originOut?: number;
    marqueeFrom?: number;
}>({});

const snapGuide = ref<number | null>(null);

function snapTime(sec: number, ignoreId?: string): number {
    if (props.snapSec <= 0) return sec;
    const candidates: number[] = [playheadSec.value];
    for (const s of segments.value) {
        if (s.id === ignoreId) continue;
        candidates.push(s.inSec, s.outSec);
    }
    let best = sec;
    let bestDist = props.snapSec;
    for (const c of candidates) {
        const d = Math.abs(c - sec);
        if (d < bestDist) { bestDist = d; best = c; }
    }
    snapGuide.value = best === sec ? null : best;
    return best;
}

function onTimelineMouseDown(e: MouseEvent) {
    if (e.button !== 0 && e.button !== 1) return;
    const target = e.target as HTMLElement;
    if (target.closest('.se-segment-handle') || target.closest('.se-segment')) return;
    (timelineRef.value as HTMLDivElement | null)?.focus();

    // Shift-drag on empty area = marquee select; plain drag = scrub playhead.
    if (e.shiftKey && props.mode !== 'trim') {
        beginMarquee(e);
        return;
    }
    if (e.button === 1) {
        beginPan(e);
        return;
    }
    beginScrub(e);
}

function beginScrub(e: MouseEvent) {
    dragMode.value = 'scrub';
    const t = pxToTime(e.clientX);
    emitSeek(t, true);
    const onMove = (ev: MouseEvent) => emitSeek(pxToTime(ev.clientX), false);
    const onUp = (ev: MouseEvent) => {
        emitSeek(pxToTime(ev.clientX), true);
        dragMode.value = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

function beginMarquee(e: MouseEvent) {
    const start = pxToTime(e.clientX);
    dragMode.value = 'marquee';
    dragContext.value = { marqueeFrom: start };
    const onMove = () => { /* visual only; list updates on up */ };
    const onUp = (ev: MouseEvent) => {
        const endT = pxToTime(ev.clientX);
        const lo = Math.min(start, endT);
        const hi = Math.max(start, endT);
        const ids = segments.value.filter((s) => s.outSec > lo && s.inSec < hi).map((s) => s.id);
        setSelection(ids);
        dragMode.value = null;
        dragContext.value = {};
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

function beginPan(e: MouseEvent) {
    const startX = e.clientX;
    const startPan = panStartSec.value;
    const onMove = (ev: MouseEvent) => {
        if (!timelineRef.value) return;
        const dx = ev.clientX - startX;
        const width = timelineRef.value.getBoundingClientRect().width;
        const deltaSec = (-dx / width) * visibleSpan.value;
        panStartSec.value = clampPan(startPan + deltaSec);
    };
    const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

// -------------- handle drag (resize segment edge) --------------

function onHandleMouseDown(seg: Segment, field: 'inSec' | 'outSec', e: MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    (timelineRef.value as HTMLDivElement | null)?.focus();
    dragMode.value = 'handle';
    dragContext.value = { id: seg.id, field };
    setSelection([seg.id]);
    let moved = false;

    const onMove = (ev: MouseEvent) => {
        if (!moved) { pushHistory(cloneSegments()); moved = true; }
        const raw = pxToTime(ev.clientX);
        const snapped = snapTime(raw, seg.id);
        updateSegmentEdge(seg.id, field, snapped);
    };
    const onUp = () => {
        snapGuide.value = null;
        dragMode.value = null;
        dragContext.value = {};
        if (moved) emit('segment-commit', segments.value);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

function onSegmentMouseDown(seg: Segment, e: MouseEvent) {
    if ((e.target as HTMLElement).closest('.se-segment-handle')) return;
    e.stopPropagation();
    (timelineRef.value as HTMLDivElement | null)?.focus();
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    if (additive) toggleSelection(seg.id);
    else setSelection([seg.id]);

    const startX = e.clientX;
    const startIn = seg.inSec;
    const startOut = seg.outSec;
    let moved = false;
    dragMode.value = 'segment';
    dragContext.value = { id: seg.id, originIn: startIn, originOut: startOut };
    const onMove = (ev: MouseEvent) => {
        if (!timelineRef.value) return;
        const rect = timelineRef.value.getBoundingClientRect();
        const dx = ev.clientX - startX;
        if (!moved && Math.abs(dx) < 2) return;
        if (!moved) { pushHistory(cloneSegments()); moved = true; }
        const delta = (dx / rect.width) * visibleSpan.value;
        const length = startOut - startIn;
        let newIn = startIn + delta;
        newIn = Math.max(0, Math.min(props.duration - length, newIn));
        const snapped = snapTime(newIn, seg.id);
        newIn = snapped;
        const newOut = Math.min(props.duration, newIn + length);
        commitSegmentChange(seg.id, { inSec: newIn, outSec: newOut }, { history: false });
    };
    const onUp = () => {
        snapGuide.value = null;
        dragMode.value = null;
        dragContext.value = {};
        if (moved) emit('segment-commit', segments.value);
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
}

// -------------- segment mutation + history --------------

const history = ref<Segment[][]>([]);
const redoStack = ref<Segment[][]>([]);
const HISTORY_LIMIT = 100;

function pushHistory(snapshot: Segment[]) {
    history.value.push(snapshot.map((s) => ({ ...s })));
    if (history.value.length > HISTORY_LIMIT) history.value.shift();
    redoStack.value = [];
}

function cloneSegments(): Segment[] {
    return segments.value.map((s) => ({ ...s }));
}

function commitSegments(next: Segment[], opts: { history?: boolean } = {}) {
    const sorted = next
        .filter((s) => s.outSec - s.inSec >= props.minSegmentSec)
        .sort((a, b) => a.inSec - b.inSec);
    if (opts.history !== false) pushHistory(cloneSegments());
    emit('update:modelValue', sorted);
}

function commitSegmentChange(id: string, patch: Partial<Segment>, opts: { history?: boolean } = {}) {
    const next = segments.value.map((s) => (s.id === id ? { ...s, ...patch } : s));
    // Keep order stable during drag (don't resort mid-drag).
    if (opts.history !== false) pushHistory(cloneSegments());
    emit('update:modelValue', next);
}

function updateSegmentEdge(id: string, field: 'inSec' | 'outSec', sec: number) {
    const seg = segments.value.find((s) => s.id === id);
    if (!seg) return;
    let inSec = seg.inSec;
    let outSec = seg.outSec;
    if (field === 'inSec') inSec = Math.min(outSec - props.minSegmentSec, Math.max(0, sec));
    else outSec = Math.max(inSec + props.minSegmentSec, Math.min(props.duration, sec));
    commitSegmentChange(id, { inSec, outSec }, { history: false });
}

function undo() {
    if (history.value.length === 0) return;
    const previous = history.value.pop()!;
    redoStack.value.push(cloneSegments());
    emit('update:modelValue', previous);
}
function redo() {
    if (redoStack.value.length === 0) return;
    const next = redoStack.value.pop()!;
    history.value.push(cloneSegments());
    emit('update:modelValue', next);
}

// -------------- overlap / validity --------------

const hasOverlap = computed(() => {
    if (overlapAllowed.value) return false;
    const sorted = [...segments.value].sort((a, b) => a.inSec - b.inSec);
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i].inSec < sorted[i - 1].outSec - 1e-6) return true;
    }
    return false;
});

const totalSelectedDuration = computed(() => segments.value.reduce((sum, s) => sum + (s.outSec - s.inSec), 0));

// -------------- mark in/out + add --------------

function segmentAt(sec: number): Segment | undefined {
    return segments.value.find((s) => sec >= s.inSec && sec <= s.outSec);
}

function selectedSegment(): Segment | undefined {
    const id = primarySelectedId.value;
    return id ? segments.value.find((s) => s.id === id) : undefined;
}

function markIn() {
    const t = clampTime(props.getCurrentTime());
    const atPH = segmentAt(t);
    if (atPH) {
        const outSec = Math.max(t + props.minSegmentSec, atPH.outSec);
        commitSegmentChange(atPH.id, { inSec: t, outSec });
        pendingInSec.value = null;
        return;
    }
    const sel = selectedSegment();
    // Only extend backward if playhead is genuinely before the selected segment.
    if (sel && t < sel.inSec) {
        commitSegmentChange(sel.id, { inSec: t });
        pendingInSec.value = null;
        return;
    }
    // Otherwise drop a pending-in marker; a subsequent `]` closes the segment.
    pendingInSec.value = t;
}

function markOut() {
    const t = clampTime(props.getCurrentTime());
    const atPH = segmentAt(t);
    if (atPH) {
        const inSec = Math.min(atPH.inSec, t - props.minSegmentSec);
        commitSegmentChange(atPH.id, { inSec: Math.max(0, inSec), outSec: t });
        pendingInSec.value = null;
        return;
    }
    // Pending wins over selection-extend: user is mid two-press flow.
    if (pendingInSec.value !== null) {
        const inSec = Math.min(pendingInSec.value, t);
        const outSec = Math.max(pendingInSec.value, t);
        pendingInSec.value = null;
        if (outSec - inSec < props.minSegmentSec) return;
        addSegmentInternal(inSec, outSec);
        return;
    }
    const sel = selectedSegment();
    if (sel && t > sel.outSec) {
        commitSegmentChange(sel.id, { outSec: t });
    }
}

function addSegmentAtPlayhead() {
    const t = clampTime(props.getCurrentTime());
    const inSec = t;
    const outSec = Math.min(props.duration, t + 10);
    if (outSec - inSec < props.minSegmentSec) return;
    addSegmentInternal(inSec, outSec);
}

function addSegmentInternal(inSec: number, outSec: number) {
    const newSeg: Segment = { id: createSegmentId(), inSec, outSec };
    if (props.mode === 'chapters' && props.rippleEdit) {
        const next = rippleInsert(segments.value, newSeg);
        commitSegments(next);
    } else {
        commitSegments([...segments.value, newSeg]);
    }
    setSelection([newSeg.id]);
    emit('segment-commit', segments.value);
}

function rippleInsert(list: Segment[], incoming: Segment): Segment[] {
    // For chapters: ensure new segment fits without overlapping; truncate neighbors if needed.
    const next = list.map((s) => ({ ...s }));
    next.push({ ...incoming });
    next.sort((a, b) => a.inSec - b.inSec);
    for (let i = 0; i < next.length; i++) {
        const cur = next[i];
        const prev = next[i - 1];
        if (prev && cur.inSec < prev.outSec) prev.outSec = cur.inSec;
    }
    return next.filter((s) => s.outSec - s.inSec >= 0.01);
}

function removeSegment(id: string) {
    commitSegments(segments.value.filter((s) => s.id !== id));
    selectedIds.value.delete(id);
}

function clearAll() {
    if (segments.value.length === 0) return;
    commitSegments([]);
    clearSelection();
    pendingInSec.value = null;
}

function clampTime(sec: number): number {
    return Math.max(0, Math.min(props.duration, sec));
}

// -------------- inline editing --------------

function updateTimeInput(id: string, field: 'inSec' | 'outSec', value: string) {
    const parsed = parseTime(value);
    if (parsed === null) return;
    const seg = segments.value.find((s) => s.id === id);
    if (!seg) return;
    let inSec = seg.inSec, outSec = seg.outSec;
    if (field === 'inSec') inSec = Math.max(0, Math.min(outSec - props.minSegmentSec, parsed));
    else outSec = Math.min(props.duration, Math.max(inSec + props.minSegmentSec, parsed));
    commitSegmentChange(id, { inSec, outSec });
    emit('segment-commit', segments.value);
}

/**
 * Push a single history snapshot when the user focuses a label, before any
 * keystrokes mutate it. Per-keystroke history would make Undo roll back one
 * character at a time, which is unusable.
 */
function onLabelFocus() {
    pushHistory(cloneSegments());
}

function updateLabel(id: string, value: string) {
    // History is pushed once on focus; per-keystroke commits skip it.
    commitSegmentChange(id, { label: value }, { history: false });
}

/** Fire the user-intentioned commit signal once when a label edit ends. */
function onLabelBlur() {
    emit('segment-commit', segments.value);
}

// -------------- keyboard --------------

const stepMultiplier = ref(1);
const helpOpen = ref(false);

function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const isTyping =
        target
        && (target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.tagName === 'SELECT'
            || target.isContentEditable);
    if (isTyping) {
        // Allow Cmd+Z / Esc even when typing; otherwise let the input handle it.
        if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) { /* fall through */ } else if (e.key === 'Escape') { (target as HTMLElement).blur(); return; } else return;
    }

    // Numeric modifiers for step size.
    if (e.key === '1') { stepMultiplier.value = 10; return; }
    if (e.key === '2') { stepMultiplier.value = 30; return; }
    if (e.key === '3') { stepMultiplier.value = 60; return; }

    switch (e.key) {
        case ' ': {
            if (props.onPlayPause) { e.preventDefault(); props.onPlayPause(); }
            return;
        }
        case '[': { e.preventDefault(); markIn(); return; }
        case ']': { e.preventDefault(); markOut(); return; }
        // NLE convention (DaVinci Resolve-style) alongside brackets.
        case 'i': case 'I': {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            e.preventDefault(); markIn(); return;
        }
        case 'o': case 'O': {
            if (e.altKey || e.ctrlKey || e.metaKey) return;
            e.preventDefault(); markOut(); return;
        }
        case 'ArrowLeft': {
            e.preventDefault();
            if (e.altKey && primarySelectedId.value) return nudgeEdge(-1);
            return stepSeek(-1);
        }
        case 'ArrowRight': {
            e.preventDefault();
            if (e.altKey && primarySelectedId.value) return nudgeEdge(1);
            return stepSeek(1);
        }
        case 'j': case 'J': { e.preventDefault(); return stepSeek(-1, 10); }
        case 'l': case 'L': { e.preventDefault(); return stepSeek(1, 10); }
        case 'k': case 'K': { if (props.onPlayPause) { e.preventDefault(); props.onPlayPause(); } return; }
        case ',': { if (props.fps > 0) { e.preventDefault(); return frameStep(-1); } return; }
        case '.': { if (props.fps > 0) { e.preventDefault(); return frameStep(1); } return; }
        case '+': case '=': { e.preventDefault(); setZoom(zoom.value * 1.5, playheadSec.value); return; }
        case '-': case '_': { e.preventDefault(); setZoom(zoom.value / 1.5, playheadSec.value); return; }
        case '0': { e.preventDefault(); zoom.value = 1; panStartSec.value = 0; return; }
        case 'z': case 'Z': {
            if (e.metaKey || e.ctrlKey) {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            }
            return;
        }
        case 'Delete': case 'Backspace': {
            if (selectedIds.value.size > 0) {
                e.preventDefault();
                const keep = segments.value.filter((s) => !selectedIds.value.has(s.id));
                commitSegments(keep);
                clearSelection();
            }
            return;
        }
        case 'Escape': {
            clearSelection();
            pendingInSec.value = null;
            helpOpen.value = false;
            return;
        }
        case '?': { helpOpen.value = !helpOpen.value; return; }
    }
}

function onKeyUp(e: KeyboardEvent) {
    if (e.key === '1' || e.key === '2' || e.key === '3') stepMultiplier.value = 1;
}

function stepSeek(direction: 1 | -1, fixedStep?: number) {
    const step = fixedStep ?? stepMultiplier.value;
    emitSeek(clampTime(props.getCurrentTime() + direction * step), true);
}
function frameStep(direction: 1 | -1) {
    if (props.fps <= 0) return;
    emitSeek(clampTime(props.getCurrentTime() + direction * (1 / props.fps)), true);
}
function nudgeEdge(direction: 1 | -1) {
    const id = primarySelectedId.value;
    if (!id) return;
    const seg = segments.value.find((s) => s.id === id)!;
    const step = props.fps > 0 ? 1 / props.fps : Math.max(0.01, props.snapSec || 0.1);
    // Nudge the edge nearest the playhead.
    const near: 'inSec' | 'outSec' = Math.abs(playheadSec.value - seg.inSec) < Math.abs(playheadSec.value - seg.outSec) ? 'inSec' : 'outSec';
    updateSegmentEdge(id, near, seg[near] + direction * step);
    emit('segment-commit', segments.value);
}

// -------------- wheel (zoom / pan) --------------

function onWheel(e: WheelEvent) {
    if (props.duration <= 0) return;
    if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const anchor = pxToTime(e.clientX);
        setZoom(zoom.value * (e.deltaY < 0 ? 1.15 : 1 / 1.15), anchor);
        return;
    }
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault();
        panStartSec.value = clampPan(panStartSec.value + (e.deltaX / 300) * visibleSpan.value);
    }
}

// -------------- touch: pinch-to-zoom + swipe-to-pan --------------

let pinchStart: { dist: number; zoom: number; anchorSec: number } | null = null;
let swipeStart: { x: number; pan: number } | null = null;

function touchDistance(t: TouchList): number {
    const [a, b] = [t[0], t[1]];
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
}
function onTouchStart(e: TouchEvent) {
    if (e.touches.length === 2) {
        const mid = (e.touches[0].clientX + e.touches[1].clientX) / 2;
        pinchStart = { dist: touchDistance(e.touches), zoom: zoom.value, anchorSec: pxToTime(mid) };
    } else if (e.touches.length === 1) {
        swipeStart = { x: e.touches[0].clientX, pan: panStartSec.value };
    }
}
function onTouchMove(e: TouchEvent) {
    if (e.touches.length === 2 && pinchStart) {
        e.preventDefault();
        const ratio = touchDistance(e.touches) / pinchStart.dist;
        setZoom(pinchStart.zoom * ratio, pinchStart.anchorSec);
    } else if (e.touches.length === 1 && swipeStart && timelineRef.value) {
        const dx = e.touches[0].clientX - swipeStart.x;
        const width = timelineRef.value.getBoundingClientRect().width;
        panStartSec.value = clampPan(swipeStart.pan - (dx / width) * visibleSpan.value);
    }
}
function onTouchEnd(e: TouchEvent) {
    if (e.touches.length < 2) pinchStart = null;
    if (e.touches.length === 0) swipeStart = null;
}

// -------------- scrollbar --------------

const scrollbarRef = ref<HTMLDivElement | null>(null);

function onScrollbarMouseDown(e: MouseEvent) {
    if (!scrollbarRef.value || props.duration <= 0) return;
    const rect = scrollbarRef.value.getBoundingClientRect();
    const startX = e.clientX;
    const target = e.target as HTMLElement;
    const isThumb = target.classList.contains('se-scrollbar-thumb');
    const startPan = panStartSec.value;
    if (!isThumb) {
        // Click track: jump pan to clicked position (center view on it).
        const ratio = (e.clientX - rect.left) / rect.width;
        panStartSec.value = clampPan(ratio * props.duration - visibleSpan.value / 2);
    }
    const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        const deltaSec = (dx / rect.width) * props.duration;
        panStartSec.value = clampPan(startPan + deltaSec);
    };
    const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
    };
    if (isThumb) {
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }
}

const scrollbarThumbStyle = computed(() => {
    if (props.duration <= 0) return { display: 'none' };
    const widthPct = (visibleSpan.value / props.duration) * 100;
    const leftPct = (viewStart.value / props.duration) * 100;
    return { width: `${widthPct}%`, left: `${leftPct}%` };
});

// -------------- ruler ticks --------------

const rulerTicks = computed(() => {
    if (props.duration <= 0 || visibleSpan.value <= 0) return [] as { sec: number; major: boolean; label: string | null }[];
    // Pick a step that produces ~6-12 ticks in view.
    const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    let step = candidates[0];
    for (const c of candidates) { if (visibleSpan.value / c <= 12) { step = c; break; } }
    const first = Math.ceil(viewStart.value / step) * step;
    const out: { sec: number; major: boolean; label: string | null }[] = [];
    for (let t = first; t <= viewEnd.value; t += step) {
        const major = Math.round(t / step) % 5 === 0;
        out.push({ sec: t, major, label: major ? formatTickLabel(t) : null });
    }
    return out;
});

function formatTickLabel(sec: number): string {
    if (sec >= 3600) return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
    if (sec >= 60) return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
    return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
}

// -------------- lifecycle --------------

watch(
    () => props.keyboardScope,
    (scope) => {
        window.removeEventListener('keydown', onKeyDown);
        window.removeEventListener('keyup', onKeyUp);
        if (scope === 'global') {
            window.addEventListener('keydown', onKeyDown);
            window.addEventListener('keyup', onKeyUp);
        }
    },
    { immediate: true },
);

onMounted(() => {
    rafId = requestAnimationFrame(tick);
});
onBeforeUnmount(() => {
    cancelAnimationFrame(rafId);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
});

// -------------- VTT helpers --------------

function exportVtt(): string {
    return props.mode === 'subtitles' ? exportSubtitlesVtt(segments.value) : exportChaptersVtt(segments.value);
}

function importVtt(text: string) {
    const parsed = parseVtt(text);
    commitSegments(parsed);
}

function isSelected(id: string): boolean {
    return selectedIds.value.has(id);
}

defineExpose({
    markIn,
    markOut,
    addSegment: addSegmentAtPlayhead,
    clearAll,
    undo,
    redo,
    zoomTo,
    exportVtt,
    importVtt,
    focus: () => timelineRef.value?.focus(),
});
</script>

<template>
    <div class="se-root" :data-mode="mode">
        <div class="se-header">
            <h3 class="se-title">{{ modeTitle }}</h3>
            <div class="se-meta">
                <span v-if="segments.length > 0">
                    {{ segments.length }} segment{{ segments.length !== 1 ? 's' : '' }}
                    · {{ formatDuration(totalSelectedDuration) }}
                </span>
                <span v-else>No segments</span>
                <button
                    v-if="showHelp"
                    type="button"
                    class="se-btn se-btn--icon"
                    title="Keyboard shortcuts (?)"
                    @click="helpOpen = !helpOpen"
                ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.09 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4M12 17h.01"/></svg></button>
            </div>
        </div>

        <div v-if="showToolbar" class="se-toolbar">
            <button type="button" class="se-btn se-btn--io" @click="markIn" title="Mark In at playhead ( I or [ )">
                <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 7v10M8 9h6M8 15h6"/></svg>
                <span class="se-btn__label">Mark In</span><span class="se-kbd" aria-hidden="true">I</span><span class="se-kbd" aria-hidden="true">[</span>
            </button>
            <button type="button" class="se-btn se-btn--io" @click="markOut" title="Mark Out at playhead ( O or ] )">
                <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 7v10M16 9h-6M16 15h-6"/></svg>
                <span class="se-btn__label">Mark Out</span><span class="se-kbd" aria-hidden="true">O</span><span class="se-kbd" aria-hidden="true">]</span>
            </button>
            <button type="button" class="se-btn" @click="addSegmentAtPlayhead" title="Add a 10-second segment at playhead">
                <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
                Add
            </button>
            <button
                type="button"
                class="se-btn se-btn--squish"
                :disabled="history.length === 0"
                @click="undo"
                title="Undo"
            ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg></button>
            <button
                type="button"
                class="se-btn se-btn--squish"
                :disabled="redoStack.length === 0"
                @click="redo"
                title="Redo"
            ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"/><path d="M20.49 9a9 9 0 1 1-2.12 9.36L23 10"/></svg></button>
            <button
                v-if="segments.length > 0"
                type="button"
                class="se-btn se-btn--danger"
                @click="clearAll"
            >
                <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M10 6V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v1"/></svg>
                Clear All
            </button>
            <span v-if="pendingInSec !== null" class="se-pending">
                In {{ formatTime(pendingInSec) }} — Mark Out <span class="se-kbd">O</span> or <span class="se-kbd">]</span>
                · <span class="se-pending-cancel">Esc cancels</span>
            </span>
            <div class="se-spacer" />
            <label class="se-zoom">
                Zoom
                <input
                    type="range"
                    min="1"
                    :max="maxZoom"
                    step="0.1"
                    :value="zoom"
                    @input="(e) => setZoom(parseFloat((e.target as HTMLInputElement).value), playheadSec)"
                />
                <span>{{ zoom.toFixed(1) }}×</span>
            </label>
            <slot name="toolbar-end" />
        </div>

        <div v-if="showPlaybackControls" class="se-time-above">
            {{ formatTime(playheadSec) }} / {{ formatTime(duration) }}
        </div>

        <div
            ref="timelineRef"
            class="se-timeline-wrap"
            :tabindex="keyboardScope === 'off' ? -1 : 0"
            @keydown="keyboardScope === 'focus' ? onKeyDown($event) : undefined"
            @keyup="keyboardScope === 'focus' ? onKeyUp($event) : undefined"
        >
            <div
                class="se-timeline"
                :class="{ 'se-timeline--subtitles': mode === 'subtitles' }"
                @mousedown="onTimelineMouseDown"
                @wheel="onWheel"
                @touchstart.passive="onTouchStart"
                @touchmove="onTouchMove"
                @touchend.passive="onTouchEnd"
                role="slider"
                :aria-valuemin="0"
                :aria-valuemax="duration"
                :aria-valuenow="playheadSec"
                :aria-label="`${modeTitle} timeline`"
            >
                <div class="se-ruler">
                    <template v-for="tick in rulerTicks" :key="tick.sec">
                        <div
                            class="se-ruler-tick"
                            :style="{ left: `${timeToPercent(tick.sec)}%`, opacity: tick.major ? 0.6 : 0.25 }"
                        />
                        <div
                            v-if="tick.label"
                            class="se-ruler-label"
                            :style="{ left: `${timeToPercent(tick.sec)}%` }"
                        >{{ tick.label }}</div>
                    </template>
                </div>

                <div
                    v-for="seg in segments"
                    :key="seg.id"
                    class="se-segment"
                    :class="{
                        'se-segment--selected': isSelected(seg.id),
                        'se-segment--invalid': hasOverlap,
                    }"
                    :style="{
                        left: `${timeToPercent(seg.inSec)}%`,
                        width: `${((seg.outSec - seg.inSec) / visibleSpan) * 100}%`,
                    }"
                    @mousedown="onSegmentMouseDown(seg, $event)"
                >
                    <div
                        class="se-segment-handle se-segment-handle--in"
                        @mousedown="onHandleMouseDown(seg, 'inSec', $event)"
                    />
                    <div
                        class="se-segment-handle se-segment-handle--out"
                        @mousedown="onHandleMouseDown(seg, 'outSec', $event)"
                    />
                    <span
                        v-if="labelsVisible && ((seg.outSec - seg.inSec) / visibleSpan) * 100 > 4"
                        class="se-segment-label"
                    >{{ seg.label || `#${segments.indexOf(seg) + 1}` }}</span>
                </div>

                <div
                    v-if="playheadPercent >= 0 && playheadPercent <= 100"
                    class="se-playhead"
                    :style="{ left: `${playheadPercent}%` }"
                />
                <div
                    v-if="snapGuide !== null"
                    class="se-snap-guide"
                    :style="{ left: `${timeToPercent(snapGuide)}%` }"
                />
                <div
                    v-if="pendingInSec !== null"
                    class="se-pending-marker"
                    :style="{ left: `${timeToPercent(pendingInSec)}%` }"
                    :title="`In at ${formatTime(pendingInSec)} — Mark Out with O or ]`"
                />
            </div>

            <div
                v-if="zoom > 1"
                ref="scrollbarRef"
                class="se-scrollbar"
                @mousedown="onScrollbarMouseDown"
            >
                <div class="se-scrollbar-thumb" :style="scrollbarThumbStyle" />
            </div>
        </div>

        <div
            v-if="showPlaybackControls && (onPlayPause || onSeek || $slots['playback-start'] || $slots['playback-end'])"
            class="se-playback-controls"
        >
            <div class="se-playback-controls__slot se-playback-controls__slot--start">
                <slot name="playback-start" />
            </div>
            <div v-if="onPlayPause || onSeek" class="se-playback-controls__center">
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn"
                    @click="stepSeek(-1)"
                    title="−1 second (←). Hold 1 / 2 / 3 before ← for −10 / −30 / −60."
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12H8"/><polyline points="13 7 8 12 13 17"/></svg>
                    <span>1s</span>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn"
                    title="−10 seconds (J)"
                    @click="stepSeek(-1, 10)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 7 10 12 15 17"/><polyline points="21 7 16 12 21 17"/></svg>
                    <span>10<span class="se-kbd se-kbd--inline">J</span></span>
                </button>
                <button
                    v-if="onPlayPause"
                    type="button"
                    class="se-btn se-btn--playback"
                    :title="'Play / pause · Space · K'"
                    :aria-label="isPlaying ? 'Pause' : 'Play'"
                    @click="onPlayPause"
                >
                    <svg
                        v-if="!isPlaying"
                        class="se-icon"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    ><path d="M10 8.125v7.75L17.625 12 10 8.125z"/></svg>
                    <svg
                        v-else
                        class="se-icon"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    ><path d="M9 9h3v6H9V9Zm5 0h3v6h-3V9z"/></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn"
                    title="+10 seconds (L)"
                    @click="stepSeek(1, 10)"
                >
                    <span>10<span class="se-kbd se-kbd--inline">L</span></span>
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 7 14 12 9 17"/><polyline points="15 7 20 12 15 17"/></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn"
                    @click="stepSeek(1)"
                    title="+1 second (→). Hold 1 / 2 / 3 before → for +10 / +30 / +60."
                >
                    <span>1s</span>
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="11 7 16 12 11 17"/><path d="M4 12h12"/></svg>
                </button>
            </div>
            <div class="se-playback-controls__slot se-playback-controls__slot--end">
                <slot name="playback-end" />
            </div>
        </div>

        <div
            v-if="showShortcutsStrip && showPlaybackControls && (onPlayPause || onSeek)"
            class="se-shortcuts-strip"
            role="note"
            aria-label="Keyboard shortcuts"
        >
            <span class="se-shortcuts-strip__group">
                <strong class="se-shortcuts-strip__title">In / Out</strong>
                <span class="se-kbd">I</span><span class="se-kbd">[</span>
                <span class="se-shortcuts-strip__sep">·</span>
                <span class="se-kbd">O</span><span class="se-kbd">]</span>
            </span>
            <span class="se-shortcuts-strip__group">
                <strong class="se-shortcuts-strip__title">Play</strong>
                <span class="se-kbd">Space</span><span class="se-kbd">K</span>
            </span>
            <span class="se-shortcuts-strip__group">
                <strong class="se-shortcuts-strip__title">Jog</strong>
                <span class="se-kbd">←</span><span class="se-kbd">→</span>
                <span class="se-shortcuts-strip__dim">1 s</span>
                <span class="se-shortcuts-strip__sep">·</span>
                <span class="se-kbd">J</span><span class="se-kbd">L</span>
                <span class="se-shortcuts-strip__dim">10 s</span>
                <span v-if="fps > 0" class="se-shortcuts-strip__frame-hint">
                    <span class="se-shortcuts-strip__sep">·</span>
                    <span class="se-kbd">,</span><span class="se-kbd">.</span>
                    <span class="se-shortcuts-strip__dim">frame ({{ fps }}&nbsp;fps)</span>
                </span>
            </span>
            <span class="se-shortcuts-strip__group">
                <strong class="se-shortcuts-strip__title">Zoom</strong>
                <span class="se-kbd">+</span><span class="se-kbd">−</span>
                <span class="se-shortcuts-strip__sep">·</span>
                <span class="se-kbd">0</span>
                <span class="se-shortcuts-strip__dim">fit</span>
            </span>
            <span class="se-shortcuts-strip__more">
                <button type="button" class="se-shortcuts-strip__help-link" @click="helpOpen = true">All shortcuts (?)</button>
            </span>
        </div>

        <div v-if="showList && segments.length > 0" class="se-list-section">
            <p
                v-if="labelsVisible && (mode === 'chapters' || mode === 'subtitles')"
                class="se-list-heading"
            >
                {{ mode === 'chapters' ? 'Chapter list' : 'Subtitle cues' }}
            </p>
            <div class="se-list">
                <div
                    v-for="(seg, i) in segments"
                    :key="seg.id"
                    class="se-list-row"
                    :class="{ 'se-list-row--selected': isSelected(seg.id) }"
                    @click="setSelection([seg.id])"
                >
                    <span class="se-list-index">{{ i + 1 }}</span>
                    <input
                        type="text"
                        class="se-input se-input--time"
                        :value="formatTime(seg.inSec)"
                        @change="updateTimeInput(seg.id, 'inSec', ($event.target as HTMLInputElement).value)"
                        @click.stop
                    />
                    <span class="se-list-sep">—</span>
                    <input
                        type="text"
                        class="se-input se-input--time"
                        :value="formatTime(seg.outSec)"
                        @change="updateTimeInput(seg.id, 'outSec', ($event.target as HTMLInputElement).value)"
                        @click.stop
                    />
                    <textarea
                        v-if="labelsVisible"
                        class="se-label-field"
                        :value="seg.label || ''"
                        :placeholder="mode === 'chapters' ? 'Chapter title…' : 'Subtitle text…'"
                        rows="1"
                        @focus="onLabelFocus"
                        @input="updateLabel(seg.id, ($event.target as HTMLTextAreaElement).value)"
                        @blur="onLabelBlur"
                        @click.stop
                    />
                    <span class="se-list-duration">{{ formatDuration(seg.outSec - seg.inSec) }}</span>
                    <button
                        type="button"
                        class="se-remove"
                        title="Remove segment"
                        aria-label="Remove segment"
                        @click.stop="removeSegment(seg.id)"
                    >
                        <svg
                            class="se-icon"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            aria-hidden="true"
                        ><path d="M8 8l8 8M16 8l-8 8"/></svg>
                    </button>
                </div>
            </div>
        </div>

        <div v-if="hasOverlap" class="se-warning">
            Segments overlap — adjust the in/out points.
        </div>

        <div v-if="helpOpen" class="se-help" @click.self="helpOpen = false">
            <div class="se-help-panel">
                <h4>Keyboard shortcuts</h4>
                <dl>
                    <dt>Space / K</dt><dd>Play / pause</dd>
                    <dt>← / →</dt><dd>Step 1 second back / forward</dd>
                    <dt>1 / 2 / 3 + arrow</dt><dd>Step 10s / 30s / 60s</dd>
                    <dt>J / L</dt><dd>Step 10s back / forward</dd>
                    <dt v-if="fps > 0">, / .</dt><dd v-if="fps > 0">Step one frame ({{ fps }} fps)</dd>
                    <dt>I</dt><dd>Mark In at playhead (Resolve-style)</dd>
                    <dt>O</dt><dd>Mark Out at playhead</dd>
                    <dt>[ / ]</dt><dd>Mark In / Mark Out (alternate)</dd>
                    <dt>Alt + ← / →</dt><dd>Nudge nearest edge of selected segment</dd>
                    <dt>Delete</dt><dd>Remove selected segment(s)</dd>
                    <dt>⌘ / Ctrl + Z</dt><dd>Undo</dd>
                    <dt>⌘ / Ctrl + Shift + Z</dt><dd>Redo</dd>
                    <dt>+ / −</dt><dd>Zoom in / out (0 resets)</dd>
                    <dt>Ctrl / ⌘ + wheel</dt><dd>Zoom at cursor</dd>
                    <dt>Shift + drag</dt><dd>Marquee-select segments</dd>
                    <dt>Esc</dt><dd>Clear selection / close</dd>
                    <dt>?</dt><dd>Toggle this help</dd>
                </dl>
            </div>
        </div>
    </div>
</template>
