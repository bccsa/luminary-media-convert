<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { Chapter, SleepTimerOption, SleepTimerState } from '@luminary-media-converter/player-core';
import { formatSeconds, type PlayerMessages } from '../messages';
import type { PlayerUpNextItem } from '../upNext';
import BrowsePanel from './BrowsePanel.vue';
import { skipIcon } from '../ui/controlsHtml';
import { SLEEP_MINUTES, SPEED_OPTIONS, chapterWindow, formatMinutes, sleepMinutesLeft } from '../ui/audioFullscreen';

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
 * It draws everything from what it is given and says what is asked through events, so it does not care which player
 * is under it: the web player's, or the app's over a native one. Only casting is the host's own, in the `cast` slot.
 */
const props = defineProps<{
    title: string;
    /** The series or collection it belongs to, small, above the title. */
    eyebrow?: string;
    /** Who it is by. */
    subtitle?: string;
    /** `fallback` is shown in its place if the picture does not load. */
    artwork: { src?: string; srcset?: string; sizes?: string; fallback?: string } | null;
    appearance: 'light' | 'dark';
    chapters: readonly Chapter[];
    currentTime: number;
    duration: number;
    bufferedEnd?: number;
    playing: boolean;
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
    /** Videos that may follow, for the panel's Up next tab. */
    upNext?: readonly PlayerUpNextItem[];
    /** Open the panel for chapters and up next on this screen, instead of asking the host (`open-browse`) to show them. */
    chaptersSheet?: boolean;
}>();

const emit = defineEmits<{
    exit: [];
    'toggle-play': [];
    seek: [time: number];
    'open-browse': [];
    'seek-chapter': [chapter: Chapter];
    upnextselect: [id: string];
    rate: [rate: number];
    'audio-track': [id: string];
    sleep: [option: SleepTimerOption | null];
}>();

type MenuId = 'speed' | 'language' | 'sleep';
const menu = ref<MenuId | null>(null);
const rootEl = ref<HTMLElement | null>(null);

const MENU_GAP = 12;

/**
 * Keeps an open menu on the screen: no taller than the room above its button, scrolling inside if it is longer,
 * and no further out than the screen's edges. The menu sits over its button centred, which in a short, wide view
 * puts it past the edge or the top.
 */
function placeMenu(): void {
    const root = rootEl.value;
    const menuEl = root?.querySelector<HTMLElement>('[role=menu]');
    const tool = menuEl?.parentElement;
    if (!root || !menuEl || !tool) return;
    const bounds = root.getBoundingClientRect();
    const room = tool.getBoundingClientRect().top - bounds.top - MENU_GAP - 8;
    menuEl.style.maxHeight = `${Math.max(120, room)}px`;
    menuEl.style.translate = '0 0';
    const rect = menuEl.getBoundingClientRect();
    const over = rect.right - (bounds.right - MENU_GAP);
    const under = bounds.left + MENU_GAP - rect.left;
    const shift = over > 0 ? -over : under > 0 ? under : 0;
    menuEl.style.translate = `${shift}px 0`;
}

watch(menu, async (id) => {
    if (!id) return;
    await nextTick();
    placeMenu();
});

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

// The bar follows the finger while it is held and asks for the seek once, when it is let go.
const dragTime = ref<number | null>(null);
const barEl = ref<HTMLElement | null>(null);
const shownTime = computed(() => dragTime.value ?? props.currentTime);
const knownDuration = computed(() => (Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0));
const pct = (seconds: number): string => `${knownDuration.value ? Math.min(100, Math.max(0, (seconds / knownDuration.value) * 100)) : 0}%`;
function timeAt(clientX: number): number {
    const rect = barEl.value?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * knownDuration.value;
}
function onBarDown(event: PointerEvent): void {
    if (!knownDuration.value) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    dragTime.value = timeAt(event.clientX);
}
function onBarMove(event: PointerEvent): void {
    if (dragTime.value !== null) dragTime.value = timeAt(event.clientX);
}
function onBarUp(): void {
    if (dragTime.value === null) return;
    emit('seek', dragTime.value);
    dragTime.value = null;
}
function onBarKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -5 : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 5 : 0;
    if (!step || !knownDuration.value) return;
    event.preventDefault();
    emit('seek', Math.min(knownDuration.value, Math.max(0, props.currentTime + step)));
}
const skip = (seconds: number): void => emit('seek', Math.min(knownDuration.value || Infinity, Math.max(0, props.currentTime + seconds)));

const browseOpen = ref(false);
const uid = `lmpl-afs-${Math.random().toString(36).slice(2, 9)}`;
function openChapters(): void {
    if (props.chaptersSheet) {
        menu.value = null;
        browseOpen.value = true;
    } else {
        emit('open-browse');
    }
}
function pickChapter(chapter: Chapter): void {
    emit('seek-chapter', chapter);
    browseOpen.value = false;
}
function pickUpNext(id: string): void {
    emit('upnextselect', id);
    browseOpen.value = false;
}

const showChapterList = computed(() => props.chapters.length > 1);
const windowRows = computed(() => chapterWindow(props.chapters, props.chapterIndex));

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

// A picture that does not load gives way to its fallback, and to the placeholder when there is none.
const coverFailed = ref(false);
watch(
    () => props.artwork?.src,
    () => (coverFailed.value = false)
);
const cover = computed(() => {
    const art = props.artwork;
    if (!art) return null;
    if (!coverFailed.value) return art;
    return art.fallback ? { src: art.fallback } : null;
});
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
            <img v-if="cover?.src && appearance === 'light'" class="lmpl-afs-wash" :src="cover.src" alt="" draggable="false" />
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
                <div v-if="cover?.src" class="lmpl-afs-halo" aria-hidden="true">
                    <img :src="cover.src" alt="" draggable="false" />
                </div>
                <img
                    v-if="cover?.src"
                    class="lmpl-afs-cover"
                    :src="cover.src"
                    :srcset="'srcset' in cover ? cover.srcset : undefined"
                    :sizes="'srcset' in cover && cover.srcset ? artworkSizes : undefined"
                    alt=""
                    draggable="false"
                    data-test="afsCover"
                    @error="coverFailed = true"
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
                        <span class="lmpl-time" data-test="afsElapsed">{{ clock(shownTime) }}</span>
                        <div
                            ref="barEl"
                            class="lmpl-afs-bar"
                            role="slider"
                            tabindex="0"
                            aria-valuemin="0"
                            :aria-valuemax="knownDuration"
                            :aria-valuenow="Math.floor(shownTime)"
                            :aria-valuetext="clock(shownTime)"
                            :aria-label="messages.scrubberLabel"
                            :class="{ 'lmpl-afs-bar-dragging': dragTime !== null }"
                            data-test="afsBar"
                            @pointerdown="onBarDown"
                            @pointermove="onBarMove"
                            @pointerup="onBarUp"
                            @pointercancel="onBarUp"
                            @keydown="onBarKey"
                        >
                            <div class="lmpl-afs-bar-track">
                                <div class="lmpl-afs-bar-buffer" :style="{ width: pct(bufferedEnd ?? 0) }"></div>
                                <div class="lmpl-afs-bar-fill" :style="{ width: pct(shownTime) }"></div>
                            </div>
                        </div>
                        <span class="lmpl-time" data-test="afsRemaining">-{{ clock(Math.max(0, knownDuration - shownTime)) }}</span>
                    </div>

                    <div class="lmpl-afs-bottomrow">
                        <div class="lmpl-afs-transport">
                            <button
                                v-if="skipBackSeconds > 0"
                                type="button"
                                class="lmpl-afs-skip"
                                :aria-label="formatSeconds(messages.skipBack, skipBackSeconds)"
                                data-test="afsSkipBack"
                                @click="skip(-skipBackSeconds)"
                                v-html="skipIcon(skipBackSeconds, false)"
                            ></button>
                            <button
                                type="button"
                                class="lmpl-afs-playbtn"
                                :aria-label="playing ? messages.pause : messages.play"
                                data-test="afsPlay"
                                @click="emit('toggle-play')"
                            >
                                <svg v-if="playing" viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M7 4h3.5v16H7zM13.5 4H17v16h-3.5z" /></svg>
                                <svg v-else viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z" /></svg>
                            </button>
                            <button
                                v-if="skipForwardSeconds > 0"
                                type="button"
                                class="lmpl-afs-skip"
                                :aria-label="formatSeconds(messages.skipForward, skipForwardSeconds)"
                                data-test="afsSkipForward"
                                @click="skip(skipForwardSeconds)"
                                v-html="skipIcon(skipForwardSeconds, true)"
                            ></button>
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
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.3 17.5a8.5 8.5 0 1 1 15.4 0" /><path d="m12 14 3.6-4.6" /><circle cx="12" cy="14.2" r="1.1" fill="currentColor" /></svg>
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

                            <slot name="cast"></slot>

                            <button
                                v-if="hasBrowse"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                                                :aria-label="messages.browse"
                                data-test="afsBrowse"
                                @click="openChapters"
                            >
                                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></svg>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Chapters and up next, over this screen: the web player's own panel. A pick goes there and it closes. -->
        <BrowsePanel
            v-if="browseOpen"
            :chapters="chapters"
            :current-chapter="chapterIndex"
            :up-next="upNext"
            :messages="messages"
            :id-prefix="uid"
            data-test="afsSheet"
            @close="browseOpen = false"
            @pick-chapter="pickChapter"
            @pick-upnext="pickUpNext"
        />
    </div>
</template>
