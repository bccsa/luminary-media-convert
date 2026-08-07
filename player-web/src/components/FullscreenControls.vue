<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PlayerControllerApi, PlayerState } from '@luminary-media-converter/player-core';
import { formatSeconds, type PlayerMessages } from '../messages';
import { mergeControls, type PlayerControlsOptions } from '../controls';
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

function formatClock(seconds: number): string {
    const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
    return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(secs).padStart(2, '0')}`;
}

const duration = computed(() => (props.state.duration > 0 ? props.state.duration : 0));
const elapsedText = computed(() => formatClock(props.state.currentTime));
const remainingText = computed(
    () => `-${formatClock(Math.max(0, duration.value - props.state.currentTime))}`,
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
                <span
                    class="lmp-fs-time lmp-fs-time-remaining"
                    :aria-label="messages.remainingLabel"
                    >{{ remainingText }}</span
                >
            </div>

            <div class="lmp-fs-menu-row">
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
</template>
