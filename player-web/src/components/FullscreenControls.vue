<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PlayerControllerApi, PlayerState } from '@luminary-media-converter/player-core';
import { formatSeconds, type PlayerMessages } from '../messages';
import { mergeControls, type PlayerControlsOptions } from '../controls';
import ScrubThumbnail from './ScrubThumbnail.vue';
import '../styles.css';

/**
 * Minimal iOS-style overlay, mounted only while the container itself is the
 * fullscreen element (never in the platform-native fullscreen mode, which
 * brings its own UI). No angle or quality UI here by design — those are
 * wrapper-API concerns for the implementing app.
 */
const props = defineProps<{
    state: PlayerState;
    messages: PlayerMessages;
    controller: PlayerControllerApi;
    /** Which controls to offer. Omitted means the library's defaults. */
    controls?: Partial<PlayerControlsOptions>;
}>();

const emit = defineEmits<{ (event: 'exit'): void }>();

/** Idle time before the overlay fades out while playing. */
const AUTO_HIDE_MS = 3000;
/** `<select>` value standing in for "subtitles off". */
const SUBTITLES_OFF = '';

const visible = ref(true);
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHideTimer(): void {
    if (hideTimer !== null) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
}

function scheduleHide(): void {
    clearHideTimer();
    // Never auto-hide while paused — the user is looking at a still frame.
    if (!props.state.playing) return;
    hideTimer = setTimeout(() => {
        visible.value = false;
    }, AUTO_HIDE_MS);
}

function reveal(): void {
    visible.value = true;
    scheduleHide();
}

watch(
    () => props.state.playing,
    (playing) => {
        if (playing) {
            scheduleHide();
        } else {
            clearHideTimer();
            visible.value = true;
        }
    },
    { immediate: true },
);

/**
 * Activity is watched on the document, not on this overlay.
 *
 * Hiding sets `pointer-events: none` — which is what lets a click through to
 * the picture underneath, and equally what stops the overlay ever seeing the
 * movement that should bring it back. Listening a level up means the pointer
 * is found wherever it moves, hidden or not.
 */
onMounted(() => {
    document.addEventListener('pointermove', reveal);
    document.addEventListener('pointerdown', reveal);
    document.addEventListener('keydown', reveal);
});

onBeforeUnmount(() => {
    clearHideTimer();
    document.removeEventListener('pointermove', reveal);
    document.removeEventListener('pointerdown', reveal);
    document.removeEventListener('keydown', reveal);
});

// --- readouts -------------------------------------------------------------

/**
 * Clock in the shape the whole video needs, not the shape this instant needs.
 *
 * `withHours` is decided by the duration and applied to both readouts, so an
 * hour-long video reads 0:08:03 rather than 8:03 — the two ends of the bar stay
 * the same shape, and the elapsed figure does not gain a field and jog the
 * layout sideways as it crosses the hour.
 */
function formatClock(seconds: number, withHours: boolean): string {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    return withHours
        ? `${hours}:${pad(minutes)}:${pad(secs)}`
        : `${minutes}:${pad(secs)}`;
}

const duration = computed(() => (props.state.duration > 0 ? props.state.duration : 0));
const showHours = computed(() => duration.value >= 3600);

const elapsedText = computed(() =>
    formatClock(props.state.currentTime, showHours.value),
);
/** The whole length, not what is left of it — a fixed point to read against. */
const durationText = computed(() => formatClock(duration.value, showHours.value));

/**
 * Played and buffered positions, as plain 0–1 numbers for the bar to size with.
 *
 * Ratios rather than percentages: a range input insets its thumb by half its
 * width at each end, so the handle travels `100% - thumb` while a percentage
 * would travel the full width. The two drift apart everywhere except the
 * midpoint, leaving the handle ahead of the fill through the first half. The
 * bands are measured against the same shortened run in CSS, which needs the
 * bare number.
 */
function ratioOf(seconds: number): number {
    if (duration.value <= 0) return 0;
    return Math.min(1, Math.max(0, seconds / duration.value));
}

const progressRatio = computed(() => ratioOf(props.state.currentTime));

/** Never behind the playhead: a band shorter than the fill would read as a gap. */
const bufferedRatio = computed(() =>
    Math.max(progressRatio.value, ratioOf(props.state.bufferedEnd)),
);

const playLabel = computed(() => (props.state.playing ? props.messages.pause : props.messages.play));

const opts = computed(() => mergeControls(props.controls));

// Menus appear only when there is an actual choice to make. Subtitles always
// gain an extra "off" entry, so a single track is already a choice.
// A host with its own selectors may switch the audio menu off entirely.
const showAudioMenu = computed(
    () => opts.value.audioMenu && props.state.audioTracks.length > 1,
);
const showSubtitleMenu = computed(() => props.state.subtitleTracks.length > 0);

// --- skip ------------------------------------------------------------------

const showSkipBack = computed(() => opts.value.skipBackSeconds > 0);
const showSkipForward = computed(() => opts.value.skipForwardSeconds > 0);

const skipBackLabel = computed(() =>
    formatSeconds(props.messages.skipBack, opts.value.skipBackSeconds),
);
const skipForwardLabel = computed(() =>
    formatSeconds(props.messages.skipForward, opts.value.skipForwardSeconds),
);

const subtitleValue = computed(() => props.state.activeSubtitleTrackId ?? SUBTITLES_OFF);

// --- actions --------------------------------------------------------------

function togglePlay(): void {
    props.controller.togglePlay();
    reveal();
}

/**
 * `PlayerController.seek` is absolute, so a skip is a computed position — which
 * means both ends need clamping.
 *
 * The far end stops short of `duration` rather than landing on it: seeking to
 * exactly the end fires `ended`, so a viewer skipping forward near the close
 * gets "finished" when they asked for "a bit further on". That is the one
 * outcome a skip button must not produce. An unknown duration leaves the far
 * end open — there is nothing to clamp against, and the engine refuses an
 * impossible position on its own.
 */
const END_GUARD_S = 0.25;

function skip(deltaSeconds: number): void {
    const { currentTime, duration: total } = props.state;
    const furthest = total > 0 ? Math.max(0, total - END_GUARD_S) : Infinity;
    props.controller.seek(
        Math.min(Math.max(0, currentTime + deltaSeconds), furthest),
    );
    reveal();
}

function skipBack(): void {
    skip(-opts.value.skipBackSeconds);
}

function skipForward(): void {
    skip(opts.value.skipForwardSeconds);
}

function onScrub(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) props.controller.seek(value);
    reveal();
}

/* -----------------------------------------------------------------------
 * Scrub preview
 *
 * Follows the pointer over the scrub area rather than the playhead: while
 * dragging, what a viewer wants to see is where they are about to land, and
 * the video itself is already showing where they are.
 *
 * Driven from `pointermove` on the wrapper because that covers both a mouse
 * hovering and a finger dragging — a range input reports neither position in
 * a way that survives the thumb inset.
 * -------------------------------------------------------------------- */

/** Pointer position over the scrub area, 0–1, or null when it is elsewhere. */
const previewRatio = ref<number | null>(null);

const previewTime = computed(() =>
    previewRatio.value === null ? null : previewRatio.value * duration.value,
);

const previewCue = computed(() => {
    const at = previewTime.value;
    if (at === null || !props.state.thumbnailsReady) return null;
    /*
     * Nudged back off the very end before looking up: cue ranges are
     * end-exclusive, so a drag to the far right of the bar lands exactly on the
     * last cue's end and matches nothing — the preview would blink out at the
     * one position a viewer is most likely to hold. The *label* keeps the true
     * time; only the frame lookup is nudged.
     */
    const lookupAt =
        duration.value > 0 ? Math.min(at, duration.value - 0.001) : at;
    return props.controller.thumbnailAt(lookupAt);
});

const previewLabel = computed(() =>
    previewTime.value === null
        ? ''
        : formatClock(previewTime.value, showHours.value),
);

function onScrubHover(event: PointerEvent): void {
    const el = event.currentTarget as HTMLElement | null;
    if (!el || duration.value <= 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    previewRatio.value = Math.min(1, Math.max(0, ratio));
}

function onScrubLeave(): void {
    previewRatio.value = null;
}

function onAudioChange(event: Event): void {
    props.controller.setAudioTrack((event.target as HTMLSelectElement).value);
    reveal();
}

function onSubtitleChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    props.controller.setSubtitleTrack(value === SUBTITLES_OFF ? null : value);
    reveal();
}
</script>

<template>
    <div class="lmp-fs" :class="{ 'lmp-fs-hidden': !visible }">
        <div class="lmp-fs-top">
            <button
                type="button"
                class="lmp-icon-btn lmp-fs-exit"
                :aria-label="messages.exitFullscreen"
                :title="messages.exitFullscreen"
                @click="emit('exit')"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                        d="M18.3 5.71 12 12.01l-6.3-6.3-1.41 1.41 6.3 6.3-6.3 6.3 1.41 1.41 6.3-6.3 6.3 6.3 1.41-1.41-6.3-6.3 6.3-6.3z"
                    />
                </svg>
            </button>
        </div>

        <div class="lmp-fs-center">
            <button
                v-if="showSkipBack"
                type="button"
                class="lmp-icon-btn lmp-fs-skip lmp-fs-skip-back"
                :aria-label="skipBackLabel"
                :title="skipBackLabel"
                @click="skipBack"
            >
                <!--
                    A ring with the interval inside it, so the control says how
                    far it goes rather than only which way. The number is SVG
                    text, not an overlaid element: it scales with the glyph and
                    centres on the ring rather than on the button box.
                -->
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                        d="M9.88 4.08A8.2 8.2 0 1 0 14.12 4.08"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                    />
                    <path d="M7.9 4.35 11.5 2.2v4.3z" />
                    <text class="lmp-fs-skip-num" x="12" y="15.3">
                        {{ opts.skipBackSeconds }}
                    </text>
                </svg>
            </button>

            <button
                type="button"
                class="lmp-icon-btn lmp-fs-play"
                :aria-label="playLabel"
                :title="playLabel"
                @click="togglePlay"
            >
                <svg v-if="state.playing" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
                </svg>
                <svg v-else viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M8 5v14l11-7z" />
                </svg>
            </button>

            <button
                v-if="showSkipForward"
                type="button"
                class="lmp-icon-btn lmp-fs-skip lmp-fs-skip-forward"
                :aria-label="skipForwardLabel"
                :title="skipForwardLabel"
                @click="skipForward"
            >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                        d="M14.12 4.08A8.2 8.2 0 1 1 9.88 4.08"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.5"
                        stroke-linecap="round"
                    />
                    <path d="M16.1 4.35 12.5 2.2v4.3z" />
                    <text class="lmp-fs-skip-num" x="12" y="15.3">
                        {{ opts.skipForwardSeconds }}
                    </text>
                </svg>
            </button>
        </div>

        <div class="lmp-fs-bar">
            <div class="lmp-fs-scrub-row">
                <span class="lmp-fs-time" :aria-label="messages.elapsedLabel">{{ elapsedText }}</span>

                <!--
                    Three stacked bands rather than one styled track: each ends
                    in a rounded cap, and the engines offer no styleable region
                    for "played" in WebKit or "buffered" anywhere. They are
                    decoration; the input lies over them at full size and keeps
                    the dragging, the keyboard and the accessible name.
                -->
                <div
                    class="lmp-fs-scrub"
                    :style="{
                        '--lmp-progress': progressRatio,
                        '--lmp-buffered': bufferedRatio,
                    }"
                    @pointermove="onScrubHover"
                    @pointerleave="onScrubLeave"
                    @pointercancel="onScrubLeave"
                >
                    <!--
                        Positioned along the bar in percent and pulled back by
                        half its own width, then clamped so it cannot hang off
                        either end of the screen at the extremes.
                    -->
                    <div
                        v-if="previewCue"
                        class="lmp-fs-scrub-preview"
                        :style="{
                            left: `clamp(0px, ${(previewRatio ?? 0) * 100}%, 100%)`,
                        }"
                    >
                        <ScrubThumbnail
                            :cue="previewCue"
                            :label="previewLabel"
                            :width="168"
                        />
                    </div>
                    <div class="lmp-fs-scrub-track" aria-hidden="true"></div>
                    <div class="lmp-fs-scrub-buffered" aria-hidden="true"></div>
                    <div class="lmp-fs-scrub-played" aria-hidden="true"></div>
                    <input
                        class="lmp-fs-scrubber"
                        type="range"
                        min="0"
                        step="0.1"
                        :max="duration"
                        :value="state.currentTime"
                        :aria-label="messages.scrubberLabel"
                        @input="onScrub"
                    />
                </div>

                <span
                    class="lmp-fs-time lmp-fs-time-duration"
                    :aria-label="messages.durationLabel"
                    >{{ durationText }}</span
                >

                <!--
                    The menus ride on the scrubber row rather than sitting in one
                    of their own: a second row cost height across the whole width
                    to hold two controls at one end of it.
                -->
                <div v-if="showAudioMenu || showSubtitleMenu" class="lmp-fs-menus">
                    <select
                        v-if="showAudioMenu"
                        class="lmp-fs-select lmp-fs-audio"
                        :aria-label="messages.audioMenuLabel"
                        :value="state.activeAudioTrackId ?? ''"
                        @change="onAudioChange"
                    >
                        <option v-for="track in state.audioTracks" :key="track.id" :value="track.id">
                            {{ track.label }}
                        </option>
                    </select>

                    <select
                        v-if="showSubtitleMenu"
                        class="lmp-fs-select lmp-fs-subtitles"
                        :aria-label="messages.subtitlesMenuLabel"
                        :value="subtitleValue"
                        @change="onSubtitleChange"
                    >
                        <option :value="SUBTITLES_OFF">{{ messages.subtitlesOff }}</option>
                        <option v-for="track in state.subtitleTracks" :key="track.id" :value="track.id">
                            {{ track.label }}
                        </option>
                    </select>
                </div>
            </div>
        </div>
    </div>
</template>
