<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Segment, SegmentEditorMode } from './types';
import { createSegmentId } from './types';
import { formatDuration, formatTime, parseTime } from './time';
import { exportChaptersVtt, exportSubtitlesVtt, parseVtt } from './vtt';
import {
    findThumbnailCue,
    parseThumbnailVtt,
    type ThumbnailSpriteCue,
} from './thumbnailVtt';
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
    /** Show the title + segment-count header row above the editor. */
    showHeader?: boolean;
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
    /** When false, hides the timeline, zoom, and in/out mark controls (list + slim toolbar only). */
    showTimeline?: boolean;
    /**
     * When true, the segment list is in a separate card below the main block (header, timeline, etc.).
     * The root becomes a transparent column; use beside a video player with independent scroll areas.
     */
    splitListPanel?: boolean;
    /** No outer panel border/shadow — use when the editor sits on the app’s own card or page background. */
    embedded?: boolean;
    /** Hide label inputs and remove buttons — use when the list is informational only. */
    readOnly?: boolean;
    /**
     * Trim/NLE layout: combine marks, zoom, dropdowns, and play/jog controls into a single row
     * directly below the timeline (instead of a toolbar above + playback row below).
     */
    combinedControls?: boolean;
    /**
     * URL of `thumbnails.vtt` (HLS sprite storyboard). Renders as a filmstrip
     * behind the track, and hovering the timeline shows the matching thumbnail.
     * Applies in every mode — marking a chapter boundary needs to see the frame
     * as much as marking a trim point does. Pass null to leave the track bare.
     */
    thumbnailVttUrl?: string | null;
    /** Audio waveform peaks (normalized 0–1 amplitude). When provided, rendered as a canvas background in the timeline. */
    waveformPeaks?: number[] | null;
    /** Color for waveform visualization. Defaults to CSS variable --se-waveform or rgba(255,255,255,0.35). */
    waveformColor?: string | null;
    /**
     * Cap on how many segments can exist. Unlimited when unset.
     *
     * At the cap, marking a new segment replaces the oldest rather than being
     * refused — a trim that allows exactly one range should let the user re-mark
     * it freely, not make them delete the old one first.
     */
    maxSegments?: number;
    /** Override the empty-state heading shown when there are no segments yet (split-list panel only). */
    emptyTitle?: string;
    /** Override the empty-state hint shown under the heading (split-list panel only). */
    emptyHint?: string;
}

const props = withDefaults(defineProps<Props>(), {
    mode: 'trim',
    minSegmentSec: 0.2,
    snapSec: 0.25,
    keyboardScope: 'focus',
    throttleSeekMs: 33,
    fps: 0,
    title: undefined,
    showHeader: true,
    showToolbar: true,
    showPlaybackControls: true,
    showList: true,
    showHelp: true,
    showTimeline: true,
    maxZoom: 40,
    isPlaying: false,
    rippleEdit: true,
    showLabels: undefined,
    allowOverlap: undefined,
    splitListPanel: false,
    embedded: false,
    readOnly: false,
    combinedControls: false,
});

const emit = defineEmits<{
    'update:modelValue': [segments: Segment[]];
    select: [ids: string[]];
    seek: [seconds: number];
    'segment-commit': [segments: Segment[]];
    /** A segment was removed. Carries it whole so consumers can offer an undo. */
    'segment-removed': [segment: Segment];
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

const clearNoun = computed(() => {
    switch (props.mode) {
        case 'chapters': return 'chapters';
        case 'subtitles': return 'subtitle cues';
        default: return 'cuts';
    }
});

/** Hint row under playback: off for trim (header ? opens the same help); on for chapters/subtitles unless overridden. */
const shortcutsStripVisible = computed(
    () => props.showTimeline && (props.showShortcutsStrip ?? props.mode !== 'trim'),
);

/** Chapter/subtitle list beside player only: one card — title + meta live in the list header, not a separate panel. */
const listOnlySplitPanel = computed(
    () =>
        props.splitListPanel &&
        !props.showToolbar &&
        !props.showTimeline &&
        !props.showPlaybackControls,
);

/** Combine marks, zoom, dropdowns and play/jog controls into one row below the timeline. */
const combinedControlsBar = computed(
    () =>
        props.combinedControls &&
        props.showTimeline &&
        (props.showToolbar || props.showPlaybackControls),
);

/** `focus` keyboard: timeline has tabindex, or list-only panel uses the root (no timeline row). */
const keyboardRootTabindex = computed(() => {
    if (props.keyboardScope !== 'focus' || !listOnlySplitPanel.value) return -1;
    return 0;
});

const rootElRef = ref<HTMLDivElement | null>(null);

function onKeyboardRootKeyDown(e: KeyboardEvent) {
    if (props.keyboardScope !== 'focus' || !listOnlySplitPanel.value) return;
    onKeyDown(e);
}

function onKeyboardRootKeyUp(e: KeyboardEvent) {
    if (props.keyboardScope !== 'focus' || !listOnlySplitPanel.value) return;
    onKeyUp(e);
}

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

/** List row activation: select, and beside-player chapters jump playhead to cue start (full editor keeps selection-only). */
function onListRowActivate(seg: Segment) {
    setSelection([seg.id]);
    if (props.mode === 'chapters' && props.splitListPanel && props.onSeek) {
        emitSeek(seg.inSec, true);
    }
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

const hasSelection = computed(() => selectedIds.value.size > 0);

/**
 * Trimming is a single-selection activity: one clip is picked, adjusted, and
 * kept or dropped. Multi-select existed for chapters and subtitles, where
 * relabelling or clearing a run of cues at once is useful, and it only made
 * trimming easier to get wrong — a stray modifier-click could add a second clip
 * to the selection and the next delete would take both.
 */
const multiSelectAllowed = computed(() => props.mode !== 'trim');

/**
 * Removes whatever is selected, as one undoable step.
 *
 * Shared by the delete button and the Delete/Backspace keys so both behave
 * identically. Each removal is announced, which the keyboard path previously
 * did not do — consumers tracking what was cut (the removed-clips list beside
 * the timeline) silently missed anything deleted with the keyboard.
 */
function deleteSelected() {
    if (selectedIds.value.size === 0) return;
    const removed = segments.value.filter((s) => selectedIds.value.has(s.id));
    commitSegments(segments.value.filter((s) => !selectedIds.value.has(s.id)));
    clearSelection();
    for (const seg of removed) emit('segment-removed', { ...seg });
}

const primarySelectedId = computed(() => {
    if (selectedIds.value.size === 0) return null;
    const ids = Array.from(selectedIds.value);
    // Primary = first in time order.
    return segments.value.find((s) => ids.includes(s.id))?.id ?? null;
});

/** Seek / jog controls need a positive duration and an onSeek handler. */
const canSeekPlayback = computed(
    () => props.duration > 0 && typeof props.onSeek === 'function',
);

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
const timelineTrackRef = ref<HTMLDivElement | null>(null);
const waveformCanvas = ref<HTMLCanvasElement | null>(null);

function timelineMetricsEl(): HTMLDivElement | null {
    return timelineTrackRef.value ?? timelineRef.value;
}

function pxToTime(clientX: number): number {
    const el = timelineMetricsEl();
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return viewStart.value + ratio * visibleSpan.value;
}

function timeToPercent(sec: number): number {
    if (visibleSpan.value <= 0) return 0;
    return ((sec - viewStart.value) / visibleSpan.value) * 100;
}

// -------------- seek throttle --------------

/**
 * Floor for seeks emitted while dragging a segment edge. The scrub default of
 * 33ms is ~30 seeks a second, which is more than an HLS player wants to service
 * mid-drag; a coarser cadence still tracks the edge smoothly enough to see.
 */
const HANDLE_DRAG_SEEK_MS = 100;

let lastSeekEmit = 0;
function emitSeek(sec: number, final: boolean, minIntervalMs?: number) {
    const clamped = Math.max(0, Math.min(props.duration, sec));
    const now = performance.now();
    const interval = Math.max(props.throttleSeekMs, minIntervalMs ?? 0);
    if (!final && now - lastSeekEmit < interval) return;
    lastSeekEmit = now;
    emit('seek', clamped);
    props.onSeek?.(clamped);
}

// -------------- timeline interaction: click-to-seek + drag-scrub + marquee --------------

type DragMode = 'scrub' | 'handle' | 'segment' | 'marquee' | 'mark' | null;
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

    // Shift-drag marks a range in trim and marquee-selects elsewhere; plain drag
    // scrubs the playhead in both.
    if (e.shiftKey && e.button === 0) {
        if (props.mode === 'trim') {
            beginMarkDrag(e);
            return;
        }
        beginMarquee(e);
        return;
    }
    if (e.button === 1) {
        beginPan(e);
        return;
    }

    // Double-press and drag marks a range too. Shift-drag does the same thing and
    // is documented, but nobody discovers a modifier on their own — this is the
    // gesture people try. Detected from the press rather than a `dblclick` event,
    // which only arrives after the second click has finished and so cannot take
    // over the drag it is meant to start.
    if (e.button === 0 && isSecondPressOf(e)) {
        lastPress = null; // A third press starts over rather than chaining.
        e.preventDefault(); // Otherwise the browser selects the labels.
        beginMarkDrag(e);
        return;
    }
    lastPress = { at: performance.now(), x: e.clientX, y: e.clientY };

    beginScrub(e);
}

/** How close together, in time and space, two presses count as one gesture. */
const DOUBLE_PRESS_MS = 350;
const DOUBLE_PRESS_SLOP_PX = 5;

let lastPress: { at: number; x: number; y: number } | null = null;

function isSecondPressOf(e: MouseEvent): boolean {
    if (!lastPress) return false;
    return (
        performance.now() - lastPress.at <= DOUBLE_PRESS_MS &&
        Math.abs(e.clientX - lastPress.x) <= DOUBLE_PRESS_SLOP_PX &&
        Math.abs(e.clientY - lastPress.y) <= DOUBLE_PRESS_SLOP_PX
    );
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

/** Live range being dragged out, in seconds. Null when no mark drag is running. */
/**
 * The stretches that will not survive the encode, as `{left, width}` percentages.
 *
 * Trim ranges are what gets kept, so everything between them is dropped. A
 * translucent tint over the kept range used to be enough to show which was
 * which, but that was against frames dimmed to a quarter strength; over
 * full-colour thumbnails a 14% wash disappears. Darkening what will be cut says
 * it with the picture itself, so it reads whatever the video happens to look
 * like — and matches how an editor expects a timeline to behave.
 *
 * Empty when nothing is marked: no marks means the whole timeline is encoded,
 * and dimming all of it would say the opposite.
 */
/**
 * The parts of the timeline to scrim over — everything the marked ranges do not
 * cover, so every one of them stays lit.
 *
 * Trim: the gaps are the cuts, and dimming them is what makes the surviving
 * footage read at a glance.
 *
 * Chapters: the same treatment answers a different question — where does each
 * chapter sit in the video. Every chapter stays lit whether or not it is
 * selected; scrimming the unselected ones hid the very thing the marks are for.
 * Which chapter is selected is said by its border, not by dimming its
 * neighbours.
 */
const discardedRanges = computed(() => {
    const basis =
        props.mode === 'trim' || props.mode === 'chapters'
            ? segments.value
            : [];

    const kept = basis
        .filter((s) => s.outSec > s.inSec)
        .slice()
        .sort((a, b) => a.inSec - b.inSec);
    if (kept.length === 0) return [];

    const spans: { from: number; to: number }[] = [];
    let cursor = 0;
    for (const seg of kept) {
        if (seg.inSec > cursor) spans.push({ from: cursor, to: seg.inSec });
        cursor = Math.max(cursor, seg.outSec);
    }
    if (cursor < props.duration) spans.push({ from: cursor, to: props.duration });

    return spans.map((s) => {
        const lo = timeToPercent(s.from);
        const hi = timeToPercent(s.to);
        return { left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` };
    });
});

const draftRange = ref<{ from: number; to: number } | null>(null);

const draftRangeStyle = computed(() => {
    const d = draftRange.value;
    if (!d) return null;
    const lo = timeToPercent(Math.min(d.from, d.to));
    const hi = timeToPercent(Math.max(d.from, d.to));
    return { left: `${lo}%`, width: `${Math.max(0, hi - lo)}%` };
});

/**
 * Shift-drag across the timeline to mark a range, rather than pressing In and Out
 * at two playhead positions.
 *
 * Plain drag stays as scrubbing — it is how the playhead is positioned, which
 * matters more now that trimming keeps a single range. Shift is free here because
 * marquee select never applied to trim.
 */
function beginMarkDrag(e: MouseEvent) {
    const start = clampTime(pxToTime(e.clientX));
    dragMode.value = 'mark';
    draftRange.value = { from: start, to: start };

    const onMove = (ev: MouseEvent) => {
        const raw = clampTime(pxToTime(ev.clientX));
        const edge = snapTime(raw);
        draftRange.value = { from: start, to: edge };
        // Show the frame under the moving edge, so in and out points are chosen
        // against the picture instead of guessed and checked afterwards. Throttled
        // like the resize drag: a seek per mouse-move is far more than a player
        // can service, and that backlog is what makes playback stutter.
        emitSeek(edge, false, HANDLE_DRAG_SEEK_MS);
    };
    const onUp = (ev: MouseEvent) => {
        const end = clampTime(pxToTime(ev.clientX));
        const lo = Math.min(start, end);
        const hi = Math.max(start, end);
        draftRange.value = null;
        snapGuide.value = null;
        dragMode.value = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);

        // A shift-click that never travelled would otherwise leave a sliver of a
        // clip behind, which is harder to notice than nothing happening.
        if (hi - lo < props.minSegmentSec) return;
        addSegmentInternal(lo, hi);
        // Park the playhead on the in-point so the player shows where the kept
        // material starts, rather than wherever the drag happened to end.
        emitSeek(lo, true);
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
        const track = timelineMetricsEl();
        if (!track) return;
        const dx = ev.clientX - startX;
        const width = track.getBoundingClientRect().width;
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

    // Playhead rides the edge being dragged, so the player shows the frame at the
    // new boundary while it is being adjusted rather than after the fact. Tracked
    // separately because intermediate emits are throttled — the release still has
    // to land the playhead exactly on the final edge.
    let lastEdge: number | null = null;

    const onMove = (ev: MouseEvent) => {
        if (!moved) { pushHistory(cloneSegments()); moved = true; }
        const raw = pxToTime(ev.clientX);
        const snapped = snapTime(raw, seg.id);
        const applied = updateSegmentEdge(seg.id, field, snapped);
        if (applied != null) {
            lastEdge = applied;
            emitSeek(applied, false, HANDLE_DRAG_SEEK_MS);
        }
    };
    const onUp = () => {
        snapGuide.value = null;
        dragMode.value = null;
        dragContext.value = {};
        if (moved) {
            emit('segment-commit', segments.value);
            if (lastEdge != null) emitSeek(lastEdge, true);
        }
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

    // Shift-drag marks a range wherever it starts. Without this the existing clip
    // would swallow the gesture, and with a single trim range that clip covers
    // exactly the stretch most likely to be re-marked.
    if (e.shiftKey && e.button === 0 && props.mode === 'trim') {
        beginMarkDrag(e);
        return;
    }
    const additive =
        multiSelectAllowed.value && (e.shiftKey || e.metaKey || e.ctrlKey);
    if (additive) toggleSelection(seg.id);
    else setSelection([seg.id]);

    const startX = e.clientX;
    const startIn = seg.inSec;
    const startOut = seg.outSec;
    let moved = false;
    dragMode.value = 'segment';
    dragContext.value = { id: seg.id, originIn: startIn, originOut: startOut };
    const onMove = (ev: MouseEvent) => {
        const track = timelineMetricsEl();
        if (!track) return;
        const rect = track.getBoundingClientRect();
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
    const onUp = (ev: MouseEvent) => {
        snapGuide.value = null;
        dragMode.value = null;
        dragContext.value = {};
        if (moved) emit('segment-commit', segments.value);
        // A click that never became a drag seeks, exactly like clicking the empty
        // track. Without this the playhead cannot be positioned inside a marked
        // range — the one place it is most needed while trimming. Additive clicks
        // are selection gestures, so they leave the playhead alone, and only the
        // primary button seeks: the empty track ignores other buttons too, and a
        // right-click opening a context menu should not move the playhead.
        else if (!additive && ev.button === 0) emitSeek(pxToTime(ev.clientX), true);
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

/** Returns the edge position actually applied after clamping, or null if the segment is gone. */
function updateSegmentEdge(
    id: string,
    field: 'inSec' | 'outSec',
    sec: number,
): number | null {
    const seg = segments.value.find((s) => s.id === id);
    if (!seg) return null;
    let inSec = seg.inSec;
    let outSec = seg.outSec;
    if (field === 'inSec') inSec = Math.min(outSec - props.minSegmentSec, Math.max(0, sec));
    else outSec = Math.max(inSec + props.minSegmentSec, Math.min(props.duration, sec));
    commitSegmentChange(id, { inSec, outSec }, { history: false });
    return field === 'inSec' ? inSec : outSec;
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

/**
 * True when the playhead sits in a gap with a segment on either side. Extending a
 * neighbour over such a gap would make it impossible to mark the gap itself, so
 * marking wins there; before the first segment or after the last, where there is
 * nothing to be ambiguous about, extending still applies.
 */
function inGapBetweenSegments(t: number): boolean {
    const list = segments.value;
    return (
        list.some((s) => s.outSec <= t) && list.some((s) => s.inSec >= t)
    );
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
    // Only extend backward if playhead is genuinely before the selected segment,
    // and is not in a gap the user is trying to mark.
    if (sel && t < sel.inSec && !inGapBetweenSegments(t)) {
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
    if (sel && t > sel.outSec && !inGapBetweenSegments(t)) {
        commitSegmentChange(sel.id, { outSec: t });
        return;
    }
    // In a gap between segments a lone `]` starts the mark instead, so the pair
    // can be pressed in either order.
    if (inGapBetweenSegments(t)) pendingInSec.value = t;
}

function addSegmentAtPlayhead() {
    const t = clampTime(props.getCurrentTime());
    const inSec = t;
    const outSec = Math.min(props.duration, t + 10);
    if (outSec - inSec < props.minSegmentSec) return;
    addSegmentInternal(inSec, outSec);
}

/**
 * The segments that survive making room for one more, given `maxSegments`.
 * Oldest give way first; everything stays when there is no cap or no pressure.
 */
function roomForOneMore(): Segment[] {
    const cap = props.maxSegments;
    if (cap == null || segments.value.length < cap) return segments.value;
    return segments.value.slice(segments.value.length - Math.max(0, cap - 1));
}

function addSegmentInternal(inSec: number, outSec: number) {
    const newSeg: Segment = { id: createSegmentId(), inSec, outSec };
    if (props.mode === 'chapters' && props.rippleEdit) {
        const next = rippleInsert(segments.value, newSeg);
        commitSegments(next);
    } else {
        // At the cap the oldest segments give way, so re-marking is one gesture
        // rather than delete-then-mark. Deliberately silent about it: nothing was
        // cut from the output, so this is not a removal consumers should record.
        commitSegments([...roomForOneMore(), newSeg]);
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
    const removed = segments.value.find((s) => s.id === id);
    commitSegments(segments.value.filter((s) => s.id !== id));
    selectedIds.value.delete(id);
    if (removed) emit('segment-removed', { ...removed });
}

function clearAll() {
    if (segments.value.length === 0) return;
    commitSegments([]);
    clearSelection();
    pendingInSec.value = null;
}

function performClearAll() {
    clearAll();
    confirmClearOpen.value = false;
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

function syncLabelFieldHeight(el: HTMLTextAreaElement) {
    const styles = getComputedStyle(el);
    const minPx = Math.ceil(parseFloat(styles.minHeight) || 0);
    const maxRaw = parseFloat(styles.maxHeight);
    const maxPx =
        Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : Number.POSITIVE_INFINITY;

    el.style.height = '0';
    const contentPx = el.scrollHeight;
    const targetPx = Math.min(Math.max(contentPx, minPx || 0), maxPx);
    el.style.height = `${targetPx}px`;
    el.style.overflowY = contentPx > targetPx + 1 ? 'auto' : 'hidden';
}

/**
 * Push a single history snapshot when the user focuses a label, before any
 * keystrokes mutate it. Per-keystroke history would make Undo roll back one
 * character at a time, which is unusable.
 */
function onLabelFocus(e: FocusEvent) {
    pushHistory(cloneSegments());
    syncLabelFieldHeight(e.target as HTMLTextAreaElement);
}

function onLabelInput(e: Event, id: string) {
    const el = e.target as HTMLTextAreaElement;
    commitSegmentChange(id, { label: el.value }, { history: false });
    syncLabelFieldHeight(el);
}

/** Fire the user-intentioned commit signal once when a label edit ends. */
function onLabelBlur(e: FocusEvent) {
    syncLabelFieldHeight(e.target as HTMLTextAreaElement);
    emit('segment-commit', segments.value);
}

// -------------- keyboard --------------

const stepMultiplier = ref(1);
const helpOpen = ref(false);
const confirmClearOpen = ref(false);

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
                deleteSelected();
            }
            return;
        }
        case 'Escape': {
            clearSelection();
            pendingInSec.value = null;
            helpOpen.value = false;
            confirmClearOpen.value = false;
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
    } else if (e.touches.length === 1 && swipeStart) {
        const track = timelineMetricsEl();
        if (!track) return;
        const dx = e.touches[0].clientX - swipeStart.x;
        const width = track.getBoundingClientRect().width;
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

// -------------- timeline thumbnail hover (trim + thumbnails.vtt) --------------

const thumbnailCues = ref<ThumbnailSpriteCue[]>([]);
const thumbPreviewStyle = ref<Record<string, string>>({ display: 'none' });
let thumbnailFetchAbort: AbortController | null = null;

function preloadThumbnailSprites(cues: ThumbnailSpriteCue[]) {
    const seen = new Set<string>();
    for (const c of cues) {
        if (seen.has(c.spriteUrl)) continue;
        seen.add(c.spriteUrl);
        const img = new Image();
        img.src = c.spriteUrl;
    }
}

watch(
    () => props.thumbnailVttUrl,
    async (url) => {
        thumbnailFetchAbort?.abort();
        thumbnailFetchAbort = null;
        thumbnailCues.value = [];
        thumbPreviewStyle.value = { display: 'none' };
        if (!url) return;
        const ac = new AbortController();
        thumbnailFetchAbort = ac;
        try {
            const res = await fetch(url, { signal: ac.signal });
            if (!res.ok) return;
            const text = await res.text();
            const baseUrl = url.substring(0, url.lastIndexOf('/'));
            const cues = parseThumbnailVtt(text, baseUrl);
            if (ac.signal.aborted) return;
            thumbnailCues.value = cues;
            preloadThumbnailSprites(cues);
        } catch (e) {
            if ((e as Error).name === 'AbortError') return;
        }
    },
    { immediate: true },
);

function hideThumbPreview() {
    thumbPreviewStyle.value = { display: 'none' };
}

function onTimelineHoverMove(e: MouseEvent) {
    if (!props.thumbnailVttUrl) return;
    if (dragMode.value !== null) {
        hideThumbPreview();
        return;
    }
    if (!thumbnailCues.value.length || !timelineRef.value) return;
    const t = pxToTime(e.clientX);
    const cue = findThumbnailCue(thumbnailCues.value, t);
    if (!cue?.w || !cue?.h) {
        hideThumbPreview();
        return;
    }
    const wrap = timelineRef.value.getBoundingClientRect();
    let left = e.clientX - wrap.left - cue.w / 2;
    left = Math.max(0, Math.min(left, wrap.width - cue.w));
    thumbPreviewStyle.value = {
        display: 'block',
        left: `${left}px`,
        bottom: '100%',
        marginBottom: '6px',
        width: `${cue.w}px`,
        height: `${cue.h}px`,
        backgroundImage: `url(${JSON.stringify(cue.spriteUrl)})`,
        backgroundPosition: `-${cue.x}px -${cue.y}px`,
        backgroundRepeat: 'no-repeat',
    };
}

function onTimelineHoverLeave() {
    hideThumbPreview();
}

// -------------- thumbnail filmstrip (background of the track) --------------

/**
 * Thumbnails tiled across the visible span, behind the waveform. Each tile crops
 * its frame out of the sprite sheet by translating the image and scaling it to the
 * strip height — no sprite dimensions needed, unlike a background-size approach.
 */
/** Filmstrip height in px. The waveform occupies the bottom half over the top of it. */
const THUMB_STRIP_HEIGHT_PX = 48;

/** Tallest a peak may reach, as a share of track height. Bars stand on the floor. */
const WAVEFORM_MAX_HEIGHT_RATIO = 1;

const trackWidthPx = ref(0);

function measureTrackWidth() {
    // Measured the same way pxToTime measures, so tile positions line up exactly
    // with the time mapping used everywhere else in the track.
    trackWidthPx.value = timelineMetricsEl()?.getBoundingClientRect().width ?? 0;
}

const thumbnailStripTiles = computed(() => {
    const cues = thumbnailCues.value;
    const width = trackWidthPx.value;
    if (!cues.length || width <= 0 || visibleSpan.value <= 0) return [];

    const sample = cues.find((c) => c.w > 0 && c.h > 0);
    if (!sample) return [];

    const scale = THUMB_STRIP_HEIGHT_PX / sample.h;
    const tileWidth = Math.max(8, sample.w * scale);
    const count = Math.ceil(width / tileWidth);

    const tiles: {
        key: string;
        left: number;
        width: number;
        src: string;
        imgStyle: Record<string, string>;
    }[] = [];

    for (let i = 0; i < count; i++) {
        const left = i * tileWidth;
        const t = viewStart.value + (left / width) * visibleSpan.value;
        const cue = findThumbnailCue(cues, t);
        if (!cue?.w || !cue?.h) continue;
        tiles.push({
            // Keyed by slot, not by cue: panning changes which frame each slot
            // shows, and a cue-derived key would tear down and rebuild every <img>
            // on each frame of a pan instead of just updating src and transform.
            key: `tile-${i}`,
            left,
            width: tileWidth,
            // Cues may span several sprite sheets, so each tile carries its own.
            src: cue.spriteUrl,
            imgStyle: {
                // translate first, then scale (CSS applies right to left), so the
                // sprite offset ends up scaled by the same factor as the frame.
                transform: `scale(${scale}) translate(${-cue.x}px, ${-cue.y}px)`,
                transformOrigin: '0 0',
            },
        });
    }
    return tiles;
});

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

// -------------- waveform rendering --------------

let waveformResizeObserver: ResizeObserver | null = null;

/** jsdom and older browsers have no ResizeObserver; the editor works without it. */
function canObserveResize(): boolean {
    return typeof ResizeObserver !== 'undefined';
}

/** Resolved once per colour change: reading a CSS variable forces style recalc. */
let waveformColorCache: { key: string; value: string } | null = null;

function resolveWaveformColor(): string {
    if (props.waveformColor) return props.waveformColor;
    const rootEl = rootElRef.value || document.documentElement;
    const key = rootEl.className;
    if (waveformColorCache?.key === key) return waveformColorCache.value;
    const value =
        getComputedStyle(rootEl).getPropertyValue('--se-waveform').trim() ||
        'rgba(255,255,255,0.35)';
    waveformColorCache = { key, value };
    return value;
}

let waveformFrame: number | null = null;

/**
 * Coalesces redraws onto the next animation frame.
 *
 * Zoom and pan move `viewStart` and `visibleSpan` many times per frame — a wheel
 * gesture or a drag fires on every event — and each one used to repaint the
 * whole canvas synchronously. Only the last state before the browser paints can
 * be seen, so the rest were work nobody ever saw.
 */
function scheduleWaveformDraw(): void {
    if (waveformFrame != null) return;
    waveformFrame = requestAnimationFrame(() => {
        waveformFrame = null;
        drawWaveform();
    });
}

function drawWaveform(): void {
    const canvas = waveformCanvas.value;
    if (!canvas || !props.waveformPeaks?.length) return;

    const container = timelineMetricsEl();
    if (!container) return;

    // Assigning width or height resets the drawing surface even when the value
    // is unchanged, so only do it when the size has actually moved. Everything
    // below repaints the full canvas anyway.
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    } else {
        canvas.getContext('2d')?.clearRect(0, 0, width, height);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const peaks = props.waveformPeaks;
    // Every bar stands on the bottom edge of the track and grows upward, so the
    // waveform reads as one shape sitting under the thumbnails. Amplitude scaling
    // and colour are unchanged from how the waveform has always drawn.
    const maxBarHeight = height * WAVEFORM_MAX_HEIGHT_RATIO;

    ctx.fillStyle = resolveWaveformColor();

    const startIdx = Math.floor((viewStart.value / props.duration) * peaks.length);
    const endIdx = Math.ceil(((viewStart.value + visibleSpan.value) / props.duration) * peaks.length);
    const rangeLen = Math.max(1, endIdx - startIdx);
    const lastPeak = peaks.length - 1;

    // One path for the whole waveform rather than a fill per column: same
    // pixels, a fraction of the canvas calls at 1000+ columns.
    ctx.beginPath();
    for (let x = 0; x < width; x++) {
        const peakIdx = startIdx + (x / width) * rangeLen;
        const idx1 = Math.floor(peakIdx);
        const t = peakIdx - idx1;

        const peak1 = peaks[Math.min(idx1, lastPeak)] || 0;
        const peak2 = peaks[Math.min(idx1 + 1, lastPeak)] || 0;
        const peak = peak1 * (1 - t) + peak2 * t;

        const barHeight = Math.max(1, peak * maxBarHeight);
        ctx.rect(x, height - barHeight, 1, barHeight);
    }
    ctx.fill();
}

watch(
    () => props.waveformColor,
    () => {
        waveformColorCache = null;
        scheduleWaveformDraw();
    },
);

watch(
    () => props.waveformPeaks,
    (peaks) => {
        // `flush: 'post'` runs after Vue applies DOM updates so the
        // `v-if="waveformPeaks?.length"` canvas exists on the first transition
        // from null/empty to populated.
        if (peaks?.length && !waveformResizeObserver && canObserveResize()) {
            const container = timelineMetricsEl();
            if (container) {
                waveformResizeObserver = new ResizeObserver(() => {
                    measureTrackWidth();
                    scheduleWaveformDraw();
                });
                waveformResizeObserver.observe(container);
            }
        }
        drawWaveform();
    },
    { flush: 'post' },
);

watch([viewStart, visibleSpan], () => {
    measureTrackWidth();
    scheduleWaveformDraw();
});


onMounted(() => {
    rafId = requestAnimationFrame(tick);
    measureTrackWidth();

    // Observe the track whether or not there are peaks: the thumbnail filmstrip
    // needs the measured width to decide how many tiles to lay down.
    const container = timelineMetricsEl();
    if (container && !waveformResizeObserver && canObserveResize()) {
        waveformResizeObserver = new ResizeObserver(() => {
            measureTrackWidth();
            scheduleWaveformDraw();
        });
        waveformResizeObserver.observe(container);
    }
    if (props.waveformPeaks?.length) drawWaveform();
});
onBeforeUnmount(() => {
    thumbnailFetchAbort?.abort();
    thumbnailFetchAbort = null;
    cancelAnimationFrame(rafId);
    if (waveformFrame != null) cancelAnimationFrame(waveformFrame);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);

    if (waveformResizeObserver) {
        waveformResizeObserver.disconnect();
        waveformResizeObserver = null;
    }
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
    removeSegment,
    clearAll,
    undo,
    redo,
    zoomTo,
    exportVtt,
    importVtt,
    focus: () => {
        if (timelineRef.value) {
            timelineRef.value.focus({ preventScroll: true });
            return;
        }
        if (props.keyboardScope === 'focus' && listOnlySplitPanel.value) {
            rootElRef.value?.focus({ preventScroll: true });
        }
    },
});
</script>

<template>
    <div
        ref="rootElRef"
        class="se-root"
        :data-mode="mode"
        :class="{
            'se-root--split-list': splitListPanel,
            'se-root--embedded': embedded,
            'se-root--combined-controls': combinedControlsBar,
        }"
        :tabindex="keyboardRootTabindex"
        @keydown="onKeyboardRootKeyDown"
        @keyup="onKeyboardRootKeyUp"
    >
        <div
            :class="splitListPanel && !listOnlySplitPanel ? 'se-split-main' : 'se-split-main--contents'"
        >
            <div v-if="!listOnlySplitPanel && showHeader" class="se-header">
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

        <div
            v-if="showToolbar && !combinedControlsBar"
            class="se-toolbar"
            :class="{ 'se-toolbar--no-timeline': !showTimeline }"
        >
            <div v-if="showTimeline" class="se-toolbar__marks">
                <button type="button" class="se-btn se-btn--squish" @click="markIn" title="Mark In at playhead ( I or [ )">
                    <span aria-hidden="true">[</span>
                </button>
                <button type="button" class="se-btn se-btn--squish" @click="markOut" title="Mark Out at playhead ( O or ] )">
                    <span aria-hidden="true">]</span>
                </button>
                <button
                    v-if="mode === 'trim'"
                    type="button"
                    class="se-btn se-btn--danger"
                    :disabled="!hasSelection"
                    :title="hasSelection ? 'Cut the selected range · Delete — undo with ⌘/Ctrl + Z' : 'Select a range on the timeline to cut it'"
                    @click="deleteSelected"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
                    Cut
                </button>
                <button
                    v-else-if="segments.length > 0"
                    type="button"
                    class="se-btn se-btn--danger"
                    @click="confirmClearOpen = true"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M10 6V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v1"/></svg>
                    Clear All
                </button>
                <button
                    type="button"
                    class="se-btn se-btn--squish"
                    :disabled="history.length === 0"
                    @click="undo"
                    title="Undo"
                ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
                <button
                    type="button"
                    class="se-btn se-btn--squish"
                    :disabled="redoStack.length === 0"
                    @click="redo"
                    title="Redo"
                ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
                <slot name="toolbar-before-clear" />
                <span v-if="pendingInSec !== null" class="se-pending">
                    In {{ formatTime(pendingInSec) }} — Mark Out <span class="se-kbd">O</span> or <span class="se-kbd">]</span>
                    · <span class="se-pending-cancel">Esc cancels</span>
                </span>
                <label v-if="showTimeline" class="se-zoom">
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
            <div
                v-if="$slots['playback-start'] || $slots['playback-end']"
                class="se-toolbar__playback-options"
                :class="{ 'se-toolbar__playback-options--stacked': !showTimeline }"
            >
                <div
                    v-if="$slots['playback-start']"
                    class="se-playback-controls__slot se-playback-controls__slot--start"
                >
                    <slot name="playback-start" />
                </div>
                <div
                    v-if="$slots['playback-end']"
                    class="se-playback-controls__slot se-playback-controls__slot--end"
                >
                    <slot name="playback-end" />
                </div>
            </div>
            <div v-if="!showTimeline" class="se-toolbar__marks se-toolbar__marks--list-only">
                <slot name="toolbar-end" />
            </div>
        </div>

        <div v-if="showPlaybackControls && !combinedControlsBar" class="se-time-above">
            {{ formatTime(playheadSec) }} / {{ formatTime(duration) }}
        </div>

        <div
            v-if="showTimeline"
            ref="timelineRef"
            class="se-timeline-wrap"
            :tabindex="keyboardScope === 'off' ? -1 : 0"
            @keydown="keyboardScope === 'focus' ? onKeyDown($event) : undefined"
            @keyup="keyboardScope === 'focus' ? onKeyUp($event) : undefined"
        >
            <div
                v-if="thumbnailVttUrl"
                class="se-thumb-preview"
                :style="thumbPreviewStyle"
            />
            <div
                ref="timelineTrackRef"
                class="se-timeline"
                :class="{ 'se-timeline--subtitles': mode === 'subtitles' }"
                @mousedown="onTimelineMouseDown"
                @mousemove="onTimelineHoverMove"
                @mouseleave="onTimelineHoverLeave"
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
                <div
                    v-if="thumbnailStripTiles.length"
                    class="se-thumb-strip"
                    aria-hidden="true"
                >
                    <div
                        v-for="tile in thumbnailStripTiles"
                        :key="tile.key"
                        class="se-thumb-tile"
                        :style="{ left: `${tile.left}px`, width: `${tile.width}px` }"
                    >
                        <img :src="tile.src" :style="tile.imgStyle" alt="" draggable="false" />
                    </div>
                </div>

                <canvas
                    v-if="waveformPeaks?.length"
                    ref="waveformCanvas"
                    class="se-waveform-canvas"
                />

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

                <!--
                    What will not survive the encode, darkened. Sits over the
                    frames and the waveform but under the marks, so the bright
                    stretches are exactly what gets kept.
                -->
                <div
                    v-for="(gap, i) in discardedRanges"
                    :key="`discarded-${i}`"
                    class="se-discarded"
                    :style="gap"
                />

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
                    <!--
                        Not in trim: the controls bar carries a Cut button that
                        acts on the selection, and a second way to remove a cut —
                        one that fires on hover, right where the range is dragged
                        and resized — was too easy to hit by accident.
                    -->
                    <button
                        v-if="mode !== 'trim' && ((seg.outSec - seg.inSec) / visibleSpan) * 100 > 6"
                        type="button"
                        class="se-segment-delete"
                        title="Remove segment"
                        aria-label="Remove segment"
                        @mousedown.stop
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
                        >
                            <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
                        </svg>
                    </button>
                </div>

                <!-- The range being dragged out, before it becomes a clip. -->
                <div
                    v-if="draftRangeStyle"
                    class="se-draft-range"
                    :style="draftRangeStyle"
                    aria-hidden="true"
                />
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
                ref="scrollbarRef"
                class="se-scrollbar"
                :class="{ 'se-scrollbar--idle': zoom <= 1 }"
                @mousedown="onScrollbarMouseDown"
            >
                <div
                    v-if="zoom > 1"
                    class="se-scrollbar-thumb"
                    :style="scrollbarThumbStyle"
                />
            </div>
        </div>

        <div
            v-if="showPlaybackControls && (onPlayPause || onSeek) && !combinedControlsBar"
            class="se-playback-controls"
        >
            <div class="se-playback-controls__center">
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Back 1 second · Left Arrow — Hold 1, 2, or 3 before ← for 10s, 30s, or 60s steps"
                    aria-label="Back 1 second"
                    @click="stepSeek(-1)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Back 10 seconds · J"
                    aria-label="Back 10 seconds (J)"
                    @click="stepSeek(-1, 10)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 7 13 12 18 17" /><polyline points="11 7 6 12 11 17" /></svg>
                </button>
                <button
                    v-if="onPlayPause"
                    type="button"
                    class="se-btn se-btn--playback"
                    title="Play or pause · Space — Also K"
                    :aria-label="isPlaying ? 'Pause' : 'Play'"
                    :aria-pressed="isPlaying"
                    @click="onPlayPause"
                >
                    <svg
                        v-if="!isPlaying"
                        class="se-icon"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    ><path d="M9 7.5L9 16.5L18 12L9 7.5z" /></svg>
                    <svg
                        v-else
                        class="se-icon"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    ><path d="M8 8h3v8H8V8Zm5 0h3v8h-3V8z" /></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Forward 10 seconds · L"
                    aria-label="Forward 10 seconds (L)"
                    @click="stepSeek(1, 10)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 7 11 12 6 17" /><polyline points="13 7 18 12 13 17" /></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Forward 1 second · Right Arrow — Hold 1, 2, or 3 before → for 10s, 30s, or 60s steps"
                    aria-label="Forward 1 second"
                    @click="stepSeek(1)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
                </button>
            </div>
        </div>

        <!--
            Trim mode: one row below the timeline with playback (back/play/forward),
            mark in/out, add, undo, redo, clear-all, zoom, and the audio/quality slots.
        -->
        <div
            v-if="combinedControlsBar"
            class="se-controls-bar"
        >
            <div class="se-controls-bar__lead">
                <div v-if="showPlaybackControls" class="se-controls-bar__time">
                    {{ formatTime(playheadSec) }} / {{ formatTime(duration) }}
                </div>
            </div>

            <div class="se-controls-bar__main">
            <div
                v-if="showPlaybackControls && (onPlayPause || onSeek)"
                class="se-controls-bar__playback"
            >
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Back 1 second · Left Arrow — Hold 1, 2, or 3 before ← for 10s, 30s, or 60s steps"
                    aria-label="Back 1 second"
                    @click="stepSeek(-1)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6" /></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Back 10 seconds · J"
                    aria-label="Back 10 seconds (J)"
                    @click="stepSeek(-1, 10)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="18 7 13 12 18 17" /><polyline points="11 7 6 12 11 17" /></svg>
                </button>
                <button
                    v-if="onPlayPause"
                    type="button"
                    class="se-btn se-btn--playback"
                    title="Play or pause · Space — Also K"
                    :aria-label="isPlaying ? 'Pause' : 'Play'"
                    :aria-pressed="isPlaying"
                    @click="onPlayPause"
                >
                    <svg
                        v-if="!isPlaying"
                        class="se-icon"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    ><path d="M9 7.5L9 16.5L18 12L9 7.5z" /></svg>
                    <svg
                        v-else
                        class="se-icon"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                        aria-hidden="true"
                    ><path d="M8 8h3v8H8V8Zm5 0h3v8h-3V8z" /></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Forward 10 seconds · L"
                    aria-label="Forward 10 seconds (L)"
                    @click="stepSeek(1, 10)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 7 11 12 6 17" /><polyline points="13 7 18 12 13 17" /></svg>
                </button>
                <button
                    v-if="onSeek"
                    type="button"
                    class="se-btn se-btn--playback-icon"
                    :disabled="!canSeekPlayback"
                    title="Forward 1 second · Right Arrow — Hold 1, 2, or 3 before → for 10s, 30s, or 60s steps"
                    aria-label="Forward 1 second"
                    @click="stepSeek(1)"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
                </button>
            </div>

            <div v-if="showToolbar" class="se-controls-bar__marks">
                <button type="button" class="se-btn se-btn--squish" @click="markIn" title="Mark In at playhead ( I or [ )">
                    <span aria-hidden="true">[</span>
                </button>
                <button type="button" class="se-btn se-btn--squish" @click="markOut" title="Mark Out at playhead ( O or ] )">
                    <span aria-hidden="true">]</span>
                </button>
                <button
                    v-if="mode === 'trim'"
                    type="button"
                    class="se-btn se-btn--danger"
                    :disabled="!hasSelection"
                    :title="hasSelection ? 'Cut the selected range · Delete — undo with ⌘/Ctrl + Z' : 'Select a range on the timeline to cut it'"
                    @click="deleteSelected"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>
                    Cut
                </button>
                <button
                    v-else-if="segments.length > 0"
                    type="button"
                    class="se-btn se-btn--danger"
                    @click="confirmClearOpen = true"
                >
                    <svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M10 6V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v1"/></svg>
                    Clear All
                </button>
                <button
                    type="button"
                    class="se-btn se-btn--squish"
                    :disabled="history.length === 0"
                    @click="undo"
                    title="Undo"
                ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg></button>
                <button
                    type="button"
                    class="se-btn se-btn--squish"
                    :disabled="redoStack.length === 0"
                    @click="redo"
                    title="Redo"
                ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg></button>
                <span v-if="pendingInSec !== null" class="se-pending">
                    In {{ formatTime(pendingInSec) }} — Mark Out <span class="se-kbd">O</span> or <span class="se-kbd">]</span>
                    · <span class="se-pending-cancel">Esc cancels</span>
                </span>
            </div>

            <div v-if="showToolbar" class="se-controls-bar__zoom">
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

            <div
                v-if="showToolbar && $slots['toolbar-before-clear']"
                class="se-controls-bar__actions"
            >
                <slot name="toolbar-before-clear" />
            </div>

            <div
                v-if="$slots['playback-start'] || $slots['playback-end']"
                class="se-controls-bar__options"
            >
                <div
                    v-if="$slots['playback-start']"
                    class="se-playback-controls__slot se-playback-controls__slot--start"
                >
                    <slot name="playback-start" />
                </div>
                <div
                    v-if="$slots['playback-end']"
                    class="se-playback-controls__slot se-playback-controls__slot--end"
                >
                    <slot name="playback-end" />
                </div>
            </div>

            </div>

            <!-- When the header is suppressed, the keyboard-shortcuts button moves to the
                 far right of the controls bar (so users still have a way to open help). -->
            <button
                v-if="showHelp && !showHeader"
                type="button"
                class="se-btn se-btn--icon se-controls-bar__help"
                title="Keyboard shortcuts (?)"
                @click="helpOpen = !helpOpen"
            ><svg class="se-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.09 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4M12 17h.01"/></svg></button>
        </div>

        <div
            v-if="shortcutsStripVisible && showPlaybackControls && (onPlayPause || onSeek)"
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

        </div>

        <div
            v-if="showList && (segments.length > 0 || listOnlySplitPanel)"
            class="se-list-section"
            :class="{ 'se-list-section--split': splitListPanel }"
        >
            <div
                v-if="
                    listOnlySplitPanel && labelsVisible && (mode === 'chapters' || mode === 'subtitles')
                "
                class="se-list-split-header"
            >
                <!--
                    Count and duration read as part of the heading, so they sit
                    with it. The right edge is left for whatever the host puts
                    there — saving, for the app.
                -->
                <div class="se-list-split-header__lead">
                    <h3 class="se-title">{{ modeTitle }}</h3>
                    <div class="se-meta">
                        <span v-if="segments.length > 0">
                            {{ segments.length }} segment{{ segments.length !== 1 ? 's' : '' }}
                            · {{ formatDuration(totalSelectedDuration) }}
                        </span>
                        <span v-else>No segments</span>
                    </div>
                </div>
                <div v-if="$slots['list-actions']" class="se-list-split-header__actions">
                    <slot name="list-actions" />
                </div>
            </div>
            <p
                v-else-if="labelsVisible && (mode === 'chapters' || mode === 'subtitles')"
                class="se-list-heading"
            >
                {{ mode === 'chapters' ? 'Chapter list' : 'Subtitle cues' }}
            </p>
            <div v-if="segments.length > 0" class="se-list">
                <div
                    v-for="(seg, i) in segments"
                    :key="seg.id"
                    class="se-list-row"
                    :class="{ 'se-list-row--selected': isSelected(seg.id) }"
                    @click="onListRowActivate(seg)"
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
                        v-if="labelsVisible && !readOnly"
                        class="se-label-field"
                        :value="seg.label || ''"
                        :placeholder="mode === 'chapters' ? 'Chapter title…' : 'Subtitle text…'"
                        rows="1"
                        @focus="onLabelFocus"
                        @input="onLabelInput($event, seg.id)"
                        @blur="onLabelBlur"
                        @click.stop
                    />
                    <span class="se-list-end">
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
                    </span>
                </div>
            </div>
            <div
                v-else-if="listOnlySplitPanel && labelsVisible && mode === 'chapters'"
                class="se-list-empty se-list-empty--split"
            >
                <div class="se-list-empty__stack">
                    <div class="se-list-empty__visual" aria-hidden="true">
                        <svg class="se-list-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                            <path d="M8 7h8M8 11h5" />
                        </svg>
                    </div>
                    <p class="se-list-empty__title">{{ emptyTitle ?? 'No chapters yet' }}</p>
                    <p class="se-list-empty__hint">
                        {{ emptyHint ?? 'Use the trim timeline below to add in/out marks, or load chapters from a VTT sidecar.' }}
                    </p>
                </div>
            </div>
            <div
                v-else-if="listOnlySplitPanel && labelsVisible && mode === 'subtitles'"
                class="se-list-empty se-list-empty--split"
            >
                <div class="se-list-empty__stack">
                    <p class="se-list-empty__title">No subtitle cues yet</p>
                    <p class="se-list-empty__hint">
                        Add cues using the timeline below.
                    </p>
                </div>
            </div>
        </div>

        <div v-if="hasOverlap" class="se-warning">
            Segments overlap — adjust the in/out points.
        </div>

        <Teleport to="body">
            <div
                v-if="helpOpen"
                class="se-help"
                role="dialog"
                aria-modal="true"
                aria-labelledby="se-help-heading"
                @click.self="helpOpen = false"
            >
                <div class="se-help-panel">
                    <h4 id="se-help-heading">Keyboard shortcuts</h4>
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
                        <dt>Double-click + drag</dt>
                        <dd v-if="mode === 'trim'">Drag out a cut on the timeline</dd>
                        <dd v-else-if="mode === 'chapters'">Drag out a chapter on the timeline</dd>
                        <dd v-else>Drag out a cue on the timeline</dd>
                        <dt>Shift + drag</dt>
                        <dd v-if="mode === 'trim'">Drag out a cut on the timeline</dd>
                        <dd v-else>Marquee-select segments</dd>
                        <dt>Esc</dt><dd>Clear selection / close</dd>
                        <dt>?</dt><dd>Toggle this help</dd>
                    </dl>
                </div>
            </div>
        </Teleport>

        <Teleport to="body">
            <div
                v-if="confirmClearOpen"
                class="se-help se-confirm"
                role="dialog"
                aria-modal="true"
                aria-labelledby="se-confirm-heading"
                @click.self="confirmClearOpen = false"
            >
                <div class="se-help-panel se-confirm-panel">
                    <h4 id="se-confirm-heading">Clear all {{ clearNoun }}?</h4>
                    <p class="se-confirm-text">
                        This removes all {{ segments.length }} {{ clearNoun }} from the timeline. You can undo with <span class="se-kbd">⌘/Ctrl</span> + <span class="se-kbd">Z</span>.
                    </p>
                    <div class="se-confirm-actions">
                        <button type="button" class="se-confirm-btn" @click="confirmClearOpen = false">Cancel</button>
                        <button type="button" class="se-confirm-btn se-confirm-btn--danger" @click="performClearAll">Clear All</button>
                    </div>
                </div>
            </div>
        </Teleport>
    </div>
</template>
