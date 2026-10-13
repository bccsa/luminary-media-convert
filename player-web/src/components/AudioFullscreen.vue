<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { Chapter, SleepTimerOption, SleepTimerState } from '@luminary-media-converter/player-core';
import type { PlayerMessages } from '../messages';
import { skipIcon } from '../ui/controlsHtml';
import { SLEEP_MINUTES, SPEED_OPTIONS, chapterWindow, formatMinutes, sleepMinutesLeft } from '../ui/audioFullscreen';
import { formatChapterOf } from '../ui/chapterBar';

/**
 * The screen fullscreen becomes when only sound is playing: a now-playing screen, not a picture with controls.
 *
 * The picture leads, then what is playing and which chapter, the timeline, the transport, and the few controls a
 * listener of speech uses: speed, language, a sleep timer, casting and the chapters. Wide, the chapters are a list
 * that follows the audio beside the picture; narrow, a chip opens them. The seek bar is cut at the chapters when
 * wide and plain when narrow.
 *
 * In `dark` the screen is plain with a glow behind the picture; in `light` it takes the picture's colour over the
 * whole screen. Both are the picture itself, blurred, so no colour has to be read from it.
 *
 * It draws the layout and a few menus; the timeline, the play button and the casting buttons are the player's own
 * elements, which find the engine through the player they sit in.
 */
const props = defineProps<{
    title: string;
    /** The series or collection it belongs to, small, above the title. */
    eyebrow?: string;
    /** Who it is by. */
    subtitle?: string;
    artwork: { src?: string; srcset?: string; sizes?: string } | null;
    appearance: 'light' | 'dark';
    chapters: readonly Chapter[];
    currentTime: number;
    /** The chapter the playhead is in; -1 for none. */
    chapterIndex: number;
    playbackRate: number;
    audioTracks: readonly { id: string; label: string }[];
    activeAudioTrackId: string | null;
    sleepTimer: SleepTimerState | null;
    hasBrowse: boolean;
    skipBackSeconds: number;
    skipForwardSeconds: number;
    /** Mask that cuts the timeline at the chapters; empty for one plain bar. */
    chapterMask: string;
    messages: PlayerMessages;
}>();

const emit = defineEmits<{
    exit: [];
    'open-browse': [];
    'seek-chapter': [chapter: Chapter];
    rate: [rate: number];
    'audio-track': [id: string];
    sleep: [option: SleepTimerOption | null];
}>();

type MenuId = 'speed' | 'language' | 'sleep';
const menu = ref<MenuId | null>(null);
const rootEl = ref<HTMLElement | null>(null);

function toggleMenu(id: MenuId): void {
    menu.value = menu.value === id ? null : id;
}

/** A pick closes the menu; so does Escape, and a press anywhere outside it. */
function closeMenu(): void {
    menu.value = null;
}
function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && menu.value) {
        event.stopPropagation();
        closeMenu();
    }
}
function onPointerdown(event: PointerEvent): void {
    if (menu.value && !(event.target instanceof Element && event.target.closest('[data-afs-tools]'))) closeMenu();
}

const showChapterList = computed(() => props.chapters.length > 1);
const windowRows = computed(() => chapterWindow(props.chapters, props.chapterIndex));
const chapterText = computed(() => {
    if (props.chapters.length < 2 || props.chapterIndex < 0) return '';
    const title = props.chapters[props.chapterIndex]?.title ?? '';
    return `${formatChapterOf(props.messages.chapterOf, props.chapterIndex + 1, props.chapters.length)}${title ? ` · ${title}` : ''}`;
});

function clock(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = String(whole % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

// The sleep timer's button says how long is left; it is looked at every half minute, which is as fine as it reads.
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;
watch(
    () => props.sleepTimer?.kind === 'minutes',
    (running) => {
        clearInterval(ticker);
        ticker = undefined;
        if (running) {
            now.value = Date.now();
            ticker = setInterval(() => (now.value = Date.now()), 30_000);
        }
    },
    { immediate: true }
);
onBeforeUnmount(() => clearInterval(ticker));

const sleepCaption = computed(() => {
    const left = sleepMinutesLeft(props.sleepTimer, now.value);
    if (left !== null) return formatMinutes(props.messages.sleepLeft, left);
    return props.sleepTimer?.kind === 'chapter' ? props.messages.sleepEndOfChapter : '';
});

function chooseSleep(option: SleepTimerOption | null): void {
    emit('sleep', option);
    closeMenu();
}
function chooseRate(rate: number): void {
    emit('rate', rate);
    closeMenu();
}
function chooseTrack(id: string): void {
    emit('audio-track', id);
    closeMenu();
}

const speedText = (rate: number): string => `${Number.isInteger(rate) ? rate : rate}×`;
const artworkSizes = computed(() => props.artwork?.sizes ?? '(min-aspect-ratio: 6/5) 40vh, 80vw');
</script>

<template>
    <div
        ref="rootEl"
        class="lmpl-afs"
        :class="`lmpl-afs-${appearance}`"
        :style="{ '--lmpl-chapter-mask': chapterMask || undefined }"
        data-test="audioFullscreen"
        @keydown="onKeydown"
        @pointerdown="onPointerdown"
    >
        <!-- The picture, blurred, as the screen's colour (light) or its glow (dark). -->
        <div class="lmpl-afs-bg" aria-hidden="true">
            <img v-if="artwork?.src && appearance === 'light'" class="lmpl-afs-wash" :src="artwork.src" alt="" draggable="false" />
        </div>

        <div class="lmpl-afs-top">
            <button
                type="button"
                class="lmpl-afs-iconbtn"
                :aria-label="messages.exitFullscreen"
                data-test="afsExit"
                @click="emit('exit')"
            >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <span class="lmpl-afs-eyebrow">{{ eyebrow }}</span>
            <span class="lmpl-afs-iconbtn lmpl-afs-spacer" aria-hidden="true"></span>
        </div>

        <div class="lmpl-afs-main">
            <div class="lmpl-afs-art">
                <div v-if="artwork?.src" class="lmpl-afs-halo" aria-hidden="true">
                    <img :src="artwork.src" alt="" draggable="false" />
                </div>
                <img
                    v-if="artwork?.src"
                    class="lmpl-afs-cover"
                    :src="artwork.src"
                    :srcset="artwork.srcset"
                    :sizes="artwork.srcset ? artworkSizes : undefined"
                    alt=""
                    draggable="false"
                    data-test="afsCover"
                />
                <div v-else class="lmpl-afs-cover lmpl-afs-cover-empty" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="40%" height="40%" fill="currentColor"><path d="M19.952 1.651a.75.75 0 0 1 .298.599V16.303a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V6.994l-9 2.572v9.737a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V5.25a.75.75 0 0 1 .544-.721l10.5-3a.75.75 0 0 1 .658.122Z" /></svg>
                </div>
            </div>

            <div class="lmpl-afs-info">
                <div class="lmpl-afs-titles">
                    <h2 class="lmpl-afs-title" data-test="afsTitle">{{ title }}</h2>
                    <p v-if="subtitle" class="lmpl-afs-subtitle">{{ subtitle }}</p>
                </div>

                <!-- Narrow: where the playhead is, and the way to the chapters. -->
                <button
                    v-if="chapterText && hasBrowse"
                    type="button"
                    class="lmpl-afs-chip"
                    data-test="afsChip"
                    @click="emit('open-browse')"
                >
                    <span class="lmpl-afs-chip-text">{{ chapterText }}</span>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 15l6-6 6 6" /></svg>
                </button>

                <!-- Wide: the chapters, a list that follows the audio. -->
                <ol v-if="showChapterList" class="lmpl-afs-chapters" data-test="afsChapters">
                    <li v-for="row in windowRows" :key="row.index">
                        <button
                            type="button"
                            class="lmpl-afs-chapter"
                            :aria-current="row.index === chapterIndex ? 'true' : undefined"
                            @click="emit('seek-chapter', row.chapter)"
                        >
                            <span class="lmpl-afs-chapter-title">{{ row.chapter.title }}</span>
                            <span class="lmpl-afs-chapter-time">{{ clock(row.chapter.startTime) }}</span>
                        </button>
                    </li>
                </ol>

                <div class="lmpl-afs-controls">
                    <div class="lmpl-afs-timeline">
                        <media-time class="lmpl-time" type="current"></media-time>
                        <media-time-slider class="media-slider media-time-slider lmpl-time-slider lmpl-afs-slider">
                            <media-slider-track class="media-slider-track lmpl-track">
                                <media-slider-buffer class="media-slider-buffer lmpl-buffer"></media-slider-buffer>
                                <media-slider-fill class="media-slider-fill lmpl-fill"></media-slider-fill>
                            </media-slider-track>
                        </media-time-slider>
                        <media-time class="lmpl-time" type="remaining"></media-time>
                    </div>

                    <div class="lmpl-afs-bottomrow">
                        <div class="lmpl-afs-transport">
                            <media-seek-button
                                v-if="skipBackSeconds > 0"
                                :seconds="-skipBackSeconds"
                                class="lmpl-seek lmpl-afs-seek"
                                v-html="skipIcon(skipBackSeconds, false)"
                            ></media-seek-button>
                            <media-play-button class="media-button lmpl-play lmpl-afs-play media-play-button">
                                <media-icon name="restart" class="media-button-icon media-play-button-restart-icon"></media-icon>
                                <media-icon name="play" class="media-button-icon media-play-button-play-icon"></media-icon>
                                <media-icon name="pause" class="media-button-icon media-play-button-pause-icon"></media-icon>
                            </media-play-button>
                            <media-seek-button
                                v-if="skipForwardSeconds > 0"
                                :seconds="skipForwardSeconds"
                                class="lmpl-seek lmpl-afs-seek"
                                v-html="skipIcon(skipForwardSeconds, true)"
                            ></media-seek-button>
                        </div>

                        <div class="lmpl-afs-tools" data-afs-tools>
                            <div class="lmpl-afs-tool">
                                <button
                                    type="button"
                                    class="lmpl-afs-iconbtn"
                                    :aria-label="messages.speedLabel"
                                    :aria-expanded="menu === 'speed'"
                                    aria-haspopup="menu"
                                    data-test="afsSpeed"
                                    @click="toggleMenu('speed')"
                                >
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M12 4a9 9 0 0 0-9 9c0 1.6.4 3.1 1.1 4.4h15.8A9 9 0 0 0 12 4Zm1 9.4-3.6-3.6 1.1-1.1 3.6 3.6a1.6 1.6 0 1 1-1.1 1.1Z" /></svg>
                                    <span v-if="playbackRate !== 1" class="lmpl-afs-badge">{{ speedText(playbackRate) }}</span>
                                </button>
                                <div v-if="menu === 'speed'" class="lmpl-afs-menu" role="menu" :aria-label="messages.speedLabel">
                                    <button v-for="rate in SPEED_OPTIONS" :key="rate" type="button" role="menuitemradio" :aria-checked="rate === playbackRate" class="lmpl-afs-menuitem" @click="chooseRate(rate)">{{ speedText(rate) }}</button>
                                </div>
                            </div>

                            <div v-if="audioTracks.length > 1" class="lmpl-afs-tool">
                                <button
                                    type="button"
                                    class="lmpl-afs-iconbtn"
                                    :aria-label="messages.audioMenuLabel"
                                    :aria-expanded="menu === 'language'"
                                    aria-haspopup="menu"
                                    data-test="afsLanguage"
                                    @click="toggleMenu('language')"
                                >
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></svg>
                                </button>
                                <div v-if="menu === 'language'" class="lmpl-afs-menu" role="menu" :aria-label="messages.audioMenuLabel">
                                    <button v-for="track in audioTracks" :key="track.id" type="button" role="menuitemradio" :aria-checked="track.id === activeAudioTrackId" class="lmpl-afs-menuitem" @click="chooseTrack(track.id)">{{ track.label }}</button>
                                </div>
                            </div>

                            <div class="lmpl-afs-tool">
                                <button
                                    type="button"
                                    class="lmpl-afs-iconbtn"
                                    :aria-label="messages.sleepTimer"
                                    :aria-expanded="menu === 'sleep'"
                                    aria-haspopup="menu"
                                    :class="{ 'lmpl-afs-on': sleepTimer }"
                                    data-test="afsSleep"
                                    @click="toggleMenu('sleep')"
                                >
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" /></svg>
                                    <span v-if="sleepCaption" class="lmpl-afs-badge" data-test="afsSleepCaption">{{ sleepCaption }}</span>
                                </button>
                                <div v-if="menu === 'sleep'" class="lmpl-afs-menu" role="menu" :aria-label="messages.sleepTimer">
                                    <button type="button" role="menuitemradio" :aria-checked="sleepTimer === null" class="lmpl-afs-menuitem" data-test="afsSleepOff" @click="chooseSleep(null)">{{ messages.sleepOff }}</button>
                                    <button v-for="minutes in SLEEP_MINUTES" :key="minutes" type="button" role="menuitemradio" class="lmpl-afs-menuitem" :data-test="`afsSleep${minutes}`" @click="chooseSleep({ kind: 'minutes', minutes })">{{ formatMinutes(messages.sleepMinutes, minutes) }}</button>
                                    <button v-if="chapters.length > 1 && chapterIndex >= 0" type="button" role="menuitemradio" :aria-checked="sleepTimer?.kind === 'chapter'" class="lmpl-afs-menuitem" data-test="afsSleepChapter" @click="chooseSleep({ kind: 'chapter' })">{{ messages.sleepEndOfChapter }}</button>
                                </div>
                            </div>

                            <media-cast-button class="media-button lmpl-icon-btn media-cast-button lmpl-afs-iconbtn">
                                <media-icon name="cast-enter" class="media-button-icon media-cast-button-enter-icon"></media-icon>
                                <media-icon name="cast-exit" class="media-button-icon media-cast-button-exit-icon"></media-icon>
                            </media-cast-button>
                            <media-airplay-button class="media-button lmpl-icon-btn media-airplay-button lmpl-afs-iconbtn">
                                <media-icon name="airplay-enter" class="media-button-icon media-airplay-button-enter-icon"></media-icon>
                                <media-icon name="airplay-exit" class="media-button-icon media-airplay-button-exit-icon"></media-icon>
                            </media-airplay-button>

                            <button
                                v-if="hasBrowse"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                :aria-label="messages.browse"
                                data-test="afsBrowse"
                                @click="emit('open-browse')"
                            >
                                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
