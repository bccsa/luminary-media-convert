<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useSlots, watch } from 'vue';
import type { Chapter, SleepTimerOption, SleepTimerState } from '@luminary-media-converter/player-core';
import { formatSeconds, type PlayerMessages } from '../messages';
import type { PlayerUpNextItem } from '../upNext';
import BrowsePanel from './BrowsePanel.vue';
import NowPlayingLyrics from './NowPlayingLyrics.vue';
import type { LyricCue } from '../ui/lyrics';
import { skipIcon } from '../ui/controlsHtml';
import type { ScrubPosition } from '../ui/audioFullscreen';
import { SLEEP_MINUTES, SPEED_OPTIONS, formatMinutes, sleepMinutesLeft } from '../ui/audioFullscreen';

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
 *
 * A host can also make it its now-playing view for video: with `stage: 'video'` the picture's place is the host's
 * `stage` slot, full width, and the tools are a video's (subtitles, picture in picture, full screen) instead of a
 * listener's. `stageHole` leaves that place transparent, for a picture the platform draws behind the page. The
 * `top-end` slot fills the right of the top line (a switch between sound and picture, say).
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
    /** A live stream: nothing to skip and no time left to show. */
    live?: boolean;
    /** The chapter the playhead is in; -1 for none. */
    chapterIndex: number;
    playbackRate: number;
    /** The video's renditions, for the quality menu; none or one and the menu is not offered. */
    qualities?: readonly { id: string; label: string }[];
    /** The rendition held, or `auto` while the player chooses. */
    activeQualityId?: string;
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
    /** What takes the picture's place: the cover, or the host's picture (`stage` slot) at full width. */
    stage?: 'cover' | 'video';
    /** The picture's width over its height, so its place takes the picture's shape; 16:9 when not known. */
    stageAspect?: number;
    /** Room under the picture for the host's subtitles. */
    captionBand?: boolean;
    /** The words being said now, under the picture, where the host shows subtitles itself. */
    caption?: string;
    /** The host draws the picture behind the page, where the stage is: nothing of the screen may cover it there. */
    stageHole?: boolean;
    /** The screen's colour in place of the cover blurred: a small picture (a ThumbHash) that is soft once stretched. */
    wash?: string;
    /** The chevron's name, where it minimises the player rather than leaving full screen. */
    exitLabel?: string;
    subtitleTracks?: readonly { id: string; label: string }[];
    activeSubtitleTrackId?: string | null;
    canPictureInPicture?: boolean;
    /** The words of what plays, timed: offered, with sound alone, as lyrics in the picture's place. */
    lyrics?: readonly LyricCue[];
}>();

const emit = defineEmits<{
    exit: [];
    /** A menu or the chapters panel is over the screen, or is not any more. */
    covered: [open: boolean];
    'toggle-play': [];
    seek: [time: number];
    'open-browse': [];
    'seek-chapter': [chapter: Chapter];
    upnextselect: [id: string];
    rate: [rate: number];
    'audio-track': [id: string];
    quality: [id: string];
    sleep: [option: SleepTimerOption | null];
    'subtitle-track': [id: string | null];
    'picture-in-picture': [];
    fullscreen: [];
    /** The stage moved or changed size: a picture drawn behind the page has to be placed again. */
    stagechange: [];
    /** The bar is held: where, for a host that shows frames in the `roster` slot. Null when it is let go. */
    scrub: [position: ScrubPosition | null];
}>();

const slots = useSlots();
const isVideo = computed(() => props.stage === 'video');
const subtitleTracks = computed(() => props.subtitleTracks ?? []);
const lyricLines = computed(() => props.lyrics ?? []);

// The words are shown while they are asked for, and only with sound alone and words to show: in the cover's place
// when the screen is tall, beside the cover, where the chapters are, when it is wide.
const lyricsOpen = ref(false);
const showLyrics = computed(() => lyricsOpen.value && !isVideo.value && lyricLines.value.length > 0);
/** Wider than tall by the layout's own measure (`min-aspect-ratio: 6/5`), as the styles lay it out. */
const wide = ref(false);
function measureWide(): void {
    const root = rootEl.value;
    if (root && root.clientHeight > 0) wide.value = root.clientWidth * 5 >= root.clientHeight * 6;
}
const lyricsInStage = computed(() => showLyrics.value && !wide.value);
const lyricsBeside = computed(() => showLyrics.value && wide.value);
// The picture puts them away. Words still on their way (another language being read) keep them asked for.
watch(isVideo, (video) => {
    if (video) lyricsOpen.value = false;
});

type MenuId = 'speed' | 'language' | 'sleep' | 'subtitles' | 'quality';
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
/** A tap leaves the button focused on a touch screen; only a keyboard's focus is worth keeping. */
function onClick(event: MouseEvent): void {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (button && !button.matches(':focus-visible')) button.blur();
}
function onPointerdown(event: PointerEvent): void {
    if (menu.value && !(event.target instanceof Element && event.target.closest('[data-afs-tools]'))) closeMenu();
}

// The bar follows the finger while it is held and asks for the seek once, when it is let go.
const dragTime = ref<number | null>(null);
const barEl = ref<HTMLElement | null>(null);
const shownTime = computed(() => dragTime.value ?? props.currentTime);
const knownDuration = computed(() => (Number.isFinite(props.duration) && props.duration > 0 ? props.duration : 0));
const isLive = computed(() => props.live === true || props.duration === Infinity);
const pct = (seconds: number): string => `${knownDuration.value ? Math.min(100, Math.max(0, (seconds / knownDuration.value) * 100)) : 0}%`;
function timeAt(clientX: number): number {
    const rect = barEl.value?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * knownDuration.value;
}
// Measured on each move, not once: a turn of the phone moves the bar mid-drag.
function announceScrub(time: number): void {
    const bar = barEl.value?.getBoundingClientRect();
    const root = rootEl.value?.getBoundingClientRect();
    if (!bar || !root || !knownDuration.value) return;
    const markerX = bar.left - root.left + Math.min(1, Math.max(0, time / knownDuration.value)) * bar.width;
    emit('scrub', { time, markerX, width: root.width, bottom: root.bottom - bar.top + 8 });
}
function onBarDown(event: PointerEvent): void {
    if (!knownDuration.value) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    dragTime.value = timeAt(event.clientX);
    announceScrub(dragTime.value);
}
function onBarMove(event: PointerEvent): void {
    if (dragTime.value === null) return;
    dragTime.value = timeAt(event.clientX);
    announceScrub(dragTime.value);
}
function onBarUp(): void {
    if (dragTime.value === null) return;
    emit('seek', dragTime.value);
    dragTime.value = null;
    emit('scrub', null);
}
function onBarKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -5 : event.key === 'ArrowRight' || event.key === 'ArrowUp' ? 5 : 0;
    if (!step || !knownDuration.value) return;
    event.preventDefault();
    emit('seek', Math.min(knownDuration.value, Math.max(0, props.currentTime + step)));
}
const skip = (seconds: number): void => emit('seek', Math.min(knownDuration.value || Infinity, Math.max(0, props.currentTime + seconds)));

const browseOpen = ref(false);
watch([menu, browseOpen], ([open, panel]) => emit('covered', open !== null || panel));
const uid = `lmpl-afs-${Math.random().toString(36).slice(2, 9)}`;
/** The tab the panel opens on; the host's default when none is asked for. */
const browseTab = ref<'chapters' | 'upnext' | undefined>(undefined);
function openChapters(tab?: 'chapters'): void {
    browseTab.value = tab;
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


/**
 * `m:ss`, or `h:mm:ss` for every time once `guide` (the length) reaches an hour, and minutes padded
 * from ten of them: all the times of one video read in one shape, so the bar between them never moves.
 */
function clock(seconds: number, guide = 0): string {
    const whole = Math.max(0, Math.floor(seconds));
    const guideWhole = Math.max(0, Math.floor(guide));
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = String(whole % 60).padStart(2, '0');
    if (h > 0 || guideWhole >= 3600) return `${h}:${String(m).padStart(2, '0')}:${s}`;
    const minutes = Math.floor(whole / 60);
    return `${guideWhole >= 600 ? String(minutes).padStart(2, '0') : minutes}:${s}`;
}
/** The length the times are read against: the video's, or the position if it has run past it. */
const timeGuide = computed(() => Math.max(knownDuration.value, shownTime.value));
/** Wide enough for the longest time and a minus, so a label never changes the bar's length. */
const timeWidth = computed(() => `${clock(timeGuide.value, timeGuide.value).length + 1}ch`);

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
function chooseQuality(id: string): void {
    emit('quality', id);
    closeMenu();
}
function chooseTrack(id: string): void {
    emit('audio-track', id);
    closeMenu();
}
function chooseSubtitles(id: string | null): void {
    emit('subtitle-track', id);
    closeMenu();
}
/** With the sound alone the subtitles are the lyrics: choosing their language shows them. */
function chooseLyrics(id: string): void {
    lyricsOpen.value = true;
    chooseSubtitles(id);
}

// The stage's band, for a picture drawn behind the page: the screen's colour is cut out there (see .lmpl-afs-hole).
const stageEl = ref<HTMLElement | null>(null);
const holeTop = ref(0);
const holeBottom = ref(0);
function measureHole(): void {
    const root = rootEl.value;
    const stageBox = stageEl.value;
    if (!root || !stageBox) return;
    const top = stageBox.getBoundingClientRect().top - root.getBoundingClientRect().top;
    // The room for subtitles under the picture is the page's, not part of the picture's hole.
    const bottom = top + stageBox.offsetHeight - (isVideo.value && props.captionBand ? 64 : 0);
    if (top === holeTop.value && bottom === holeBottom.value) return;
    holeTop.value = top;
    holeBottom.value = bottom;
    emit('stagechange');
}
/**
 * The stage moves without changing size whenever something around it does (the title wrapping, the top line
 * filling in): portrait spreads the parts evenly. Every part is watched, since a move alone reports nothing.
 */
let holeObserver: ResizeObserver | null = null;
onMounted(() => {
    measureWide();
    if (typeof ResizeObserver === 'undefined') return;
    holeObserver = new ResizeObserver(() => {
        measureWide();
        measureHole();
    });
    const root = rootEl.value;
    if (!root) return;
    holeObserver.observe(root);
    for (const part of root.querySelectorAll(':scope > .lmpl-afs-top, :scope > .lmpl-afs-main, :scope > .lmpl-afs-main > *')) {
        holeObserver.observe(part);
    }
});
watch([isVideo, () => props.stageHole], async () => {
    await nextTick();
    measureHole();
});
onBeforeUnmount(() => holeObserver?.disconnect());

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
const washSrc = computed(() => props.wash || cover.value?.src);
</script>

<template>
    <div
        ref="rootEl"
        class="lmpl-afs"
        :class="[
            `lmpl-afs-${appearance}`,
            {
                'lmpl-afs-nolist': !lyricsBeside,
                'lmpl-afs-video': isVideo,
                'lmpl-afs-hole': isVideo && stageHole,
                'lmpl-afs-captions': isVideo && captionBand,
            },
        ]"
        :style="{
            '--lmpl-chapter-mask': chapterMask || undefined,
            '--lmpl-hole-top': `${holeTop}px`,
            '--lmpl-hole-bottom': `${holeBottom}px`,
            '--lmpl-stage-ar': stageAspect && stageAspect > 0 ? String(stageAspect) : undefined,
        }"
        data-test="audioFullscreen"
        @keydown="onKeydown"
        @pointerdown="onPointerdown"
        @click="onClick"
    >
        <!-- The picture, blurred, as the screen's colour: lighter in `light`, darker in `dark`. -->
        <div class="lmpl-afs-bg" aria-hidden="true">
            <img v-if="washSrc" class="lmpl-afs-wash" :class="{ 'lmpl-afs-wash-hash': wash }" :src="washSrc" alt="" draggable="false" data-test="afsWash" />
        </div>

        <!-- A picture drawn behind the page: the wash is cut at the picture and the lower part carries on from the upper. -->
        <div v-if="isVideo && stageHole && washSrc" class="lmpl-afs-bg lmpl-afs-bg-low" aria-hidden="true">
            <div class="lmpl-afs-bg-shift" :style="{ transform: `translateY(${holeBottom - holeTop}px)` }">
                <img class="lmpl-afs-wash" :class="{ 'lmpl-afs-wash-hash': wash }" :src="washSrc" alt="" draggable="false" />
            </div>
        </div>

        <slot name="roster"></slot>

        <div class="lmpl-afs-top">
            <button
                type="button"
                class="lmpl-afs-iconbtn"
                :aria-label="exitLabel || messages.exitFullscreen"
                data-test="afsExit"
                @click="emit('exit')"
            >
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            <span class="lmpl-afs-toptitle" data-test="afsTopTitle">{{ title }}</span>
            <span class="lmpl-afs-eyebrow">{{ eyebrow }}</span>
            <div v-if="slots['top-end']" class="lmpl-afs-topend" data-test="afsTopEnd"><slot name="top-end"></slot></div>
            <span v-else class="lmpl-afs-iconbtn lmpl-afs-spacer" aria-hidden="true"></span>
        </div>

        <div class="lmpl-afs-main">
            <div ref="stageEl" class="lmpl-afs-art" :class="{ 'lmpl-afs-art-lyrics': lyricsInStage }" data-test="afsStage">
                <!-- The host's player stays mounted with sound alone, only hidden, so switching never stops playback. -->
                <div v-if="slots.stage" v-show="isVideo" class="lmpl-afs-stage" data-test="afsStageSlot"><slot name="stage"></slot></div>
                <p v-if="isVideo && caption" class="lmpl-afs-caption" data-test="afsCaption">{{ caption }}</p>
                <!-- A drag along the picture's foot scrubs like the bar, for a thumb that lands short of it. -->
                <div
                    v-if="isVideo && knownDuration && !isLive"
                    class="lmpl-afs-scrubzone"
                    data-test="afsScrubZone"
                    @pointerdown="onBarDown"
                    @pointermove="onBarMove"
                    @pointerup="onBarUp"
                    @pointercancel="onBarUp"
                ></div>
                <NowPlayingLyrics
                    v-if="lyricsInStage"
                    :lines="lyricLines"
                    :current-time="currentTime"
                    :playing="playing"
                    :rate="playbackRate"
                    :label="messages.lyrics"
                    @seek="emit('seek', $event)"
                />
                <img
                    v-else-if="!isVideo && cover?.src"
                    class="lmpl-afs-cover"
                    :src="cover.src"
                    :srcset="'srcset' in cover ? cover.srcset : undefined"
                    :sizes="'srcset' in cover && cover.srcset ? artworkSizes : undefined"
                    alt=""
                    draggable="false"
                    data-test="afsCover"
                    @error="coverFailed = true"
                />
                <div v-else-if="!isVideo" class="lmpl-afs-cover lmpl-afs-cover-empty" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="40%" height="40%" fill="currentColor"><path d="M19.952 1.651a.75.75 0 0 1 .298.599V16.303a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V6.994l-9 2.572v9.737a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V5.25a.75.75 0 0 1 .544-.721l10.5-3a.75.75 0 0 1 .658.122Z" /></svg>
                </div>
            </div>

            <div class="lmpl-afs-info">
                <div class="lmpl-afs-titles">
                    <h2 class="lmpl-afs-title" data-test="afsTitle">{{ title }}</h2>
                    <p v-if="subtitle" class="lmpl-afs-subtitle">{{ subtitle }}</p>
                </div>

                <!-- Wide: the lyrics, when they are on, beside the cover. -->
                <div v-if="lyricsBeside" class="lmpl-afs-sidelyrics" data-test="afsSideLyrics">
                    <NowPlayingLyrics
                        :lines="lyricLines"
                        :current-time="currentTime"
                        :playing="playing"
                        :rate="playbackRate"
                        :label="messages.lyrics"
                        @seek="emit('seek', $event)"
                    />
                </div>

                <div class="lmpl-afs-controls">
                    <div class="lmpl-afs-timeline">
                        <span class="lmpl-time" :style="{ minWidth: timeWidth }" data-test="afsElapsed">{{ clock(shownTime, timeGuide) }}</span>
                        <div
                            ref="barEl"
                            class="lmpl-afs-bar"
                            role="slider"
                            tabindex="0"
                            aria-valuemin="0"
                            :aria-valuemax="knownDuration"
                            :aria-valuenow="Math.floor(shownTime)"
                            :aria-valuetext="clock(shownTime, timeGuide)"
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
                        <span v-if="isLive" class="lmpl-time lmpl-afs-live" data-test="afsLive">{{ messages.live }}</span>
                        <span v-else class="lmpl-time lmpl-time-end" :style="{ minWidth: timeWidth }" data-test="afsRemaining">-{{ clock(Math.max(0, knownDuration - shownTime), timeGuide) }}</span>
                    </div>

                    <div class="lmpl-afs-bottomrow">
                        <div class="lmpl-afs-transport">
                            <button
                                v-if="skipBackSeconds > 0 && !isLive"
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
                                <svg v-if="playing" viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><rect x="6.2" y="4.8" width="4" height="14.4" rx="1.8" /><rect x="13.8" y="4.8" width="4" height="14.4" rx="1.8" /></svg>
                                <svg v-else viewBox="0 0 24 24" width="30" height="30" fill="currentColor" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" aria-hidden="true"><path d="M20.4 12 7.8 4.73v14.54Z" /></svg>
                            </button>
                            <button
                                v-if="skipForwardSeconds > 0 && !isLive"
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
                                    <media-icon name="speed" class="media-button-icon"></media-icon>
                                    <span v-if="playbackRate !== 1" class="lmpl-afs-badge">{{ speedText(playbackRate) }}</span>
                                </button>
                                <div v-if="menu === 'speed'" class="lmpl-afs-menu" role="menu" :aria-label="messages.speedLabel">
                                    <button v-for="rate in SPEED_OPTIONS" :key="rate" type="button" role="menuitemradio" :aria-checked="rate === playbackRate" class="lmpl-afs-menuitem" @click="chooseRate(rate)">{{ speedText(rate) }}</button>
                                </div>
                            </div>

                            <div v-if="isVideo && (qualities?.length ?? 0) > 1" class="lmpl-afs-tool">
                                <button
                                    type="button"
                                    class="lmpl-afs-iconbtn"
                                    :aria-label="messages.qualityLabel"
                                    :aria-expanded="menu === 'quality'"
                                    aria-haspopup="menu"
                                    data-test="afsQuality"
                                    @click="toggleMenu('quality')"
                                >
                                    <media-icon name="switches" class="media-button-icon"></media-icon>
                                    <span v-if="activeQualityId && activeQualityId !== 'auto'" class="lmpl-afs-badge">{{ qualities?.find((q) => q.id === activeQualityId)?.label }}</span>
                                </button>
                                <div v-if="menu === 'quality'" class="lmpl-afs-menu" role="menu" :aria-label="messages.qualityLabel">
                                    <button type="button" role="menuitemradio" :aria-checked="!activeQualityId || activeQualityId === 'auto'" class="lmpl-afs-menuitem" data-test="afsQualityAuto" @click="chooseQuality('auto')">{{ messages.qualityAuto }}</button>
                                    <button v-for="quality in qualities" :key="quality.id" type="button" role="menuitemradio" :aria-checked="quality.id === activeQualityId" class="lmpl-afs-menuitem" @click="chooseQuality(quality.id)">{{ quality.label }}</button>
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
                                    <svg viewBox="0 0 18 18" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.125" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7.875 15.75 3.938-8.438L15.75 15.75m-6.75-2.25h5.625M2.25 4.216a36.355 36.355 0 0 1 4.5-.278m0 0c.84 0 1.675.028 2.501.086M6.75 3.938V2.25m2.501 1.773C8.382 7.993 5.768 11.31 2.25 13.127m7-9.104c.672.046 1.339.11 1.999.193m-3.442 6.371a13.517 13.517 0 0 1-2.87-4.351" /></svg>
                                </button>
                                <div v-if="menu === 'language'" class="lmpl-afs-menu" role="menu" :aria-label="messages.audioMenuLabel">
                                    <button v-for="track in audioTracks" :key="track.id" type="button" role="menuitemradio" :aria-checked="track.id === activeAudioTrackId" class="lmpl-afs-menuitem" @click="chooseTrack(track.id)">{{ track.label }}</button>
                                </div>
                            </div>

                            <div v-if="!isVideo" class="lmpl-afs-tool">
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

                            <button
                                v-if="!isVideo && lyricLines.length > 0"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                :class="{ 'lmpl-afs-on': showLyrics }"
                                :aria-label="messages.lyrics"
                                :aria-pressed="showLyrics"
                                data-test="afsLyricsToggle"
                                @click="lyricsOpen = !lyricsOpen"
                            >
                                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16M4 10h10M4 14h16M4 18h7" /><circle cx="18" cy="18" r="2" /></svg>
                            </button>

                            <div v-if="!isVideo && subtitleTracks.length > 1" class="lmpl-afs-tool">
                                <button
                                    type="button"
                                    class="lmpl-afs-iconbtn"
                                    :aria-label="messages.lyricsLanguage"
                                    :aria-expanded="menu === 'subtitles'"
                                    aria-haspopup="menu"
                                    data-test="afsLyricsLanguage"
                                    @click="toggleMenu('subtitles')"
                                >
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M7 14h4M13 14h4M7 10.5h2M11 10.5h6" /></svg>
                                </button>
                                <div v-if="menu === 'subtitles'" class="lmpl-afs-menu" role="menu" :aria-label="messages.lyricsLanguage">
                                    <button v-for="track in subtitleTracks" :key="track.id" type="button" role="menuitemradio" :aria-checked="track.id === activeSubtitleTrackId" class="lmpl-afs-menuitem" @click="chooseLyrics(track.id)">{{ track.label }}</button>
                                </div>
                            </div>

                            <div v-if="isVideo && subtitleTracks.length > 0" class="lmpl-afs-tool">
                                <button
                                    type="button"
                                    class="lmpl-afs-iconbtn"
                                    :class="{ 'lmpl-afs-on': activeSubtitleTrackId }"
                                    :aria-label="messages.subtitlesMenuLabel"
                                    :aria-expanded="menu === 'subtitles'"
                                    aria-haspopup="menu"
                                    data-test="afsSubtitles"
                                    @click="toggleMenu('subtitles')"
                                >
                                    <media-icon name="captions-off" class="media-button-icon"></media-icon>
                                </button>
                                <div v-if="menu === 'subtitles'" class="lmpl-afs-menu" role="menu" :aria-label="messages.subtitlesMenuLabel">
                                    <button type="button" role="menuitemradio" :aria-checked="!activeSubtitleTrackId" class="lmpl-afs-menuitem" data-test="afsSubtitlesOff" @click="chooseSubtitles(null)">{{ messages.subtitlesOff }}</button>
                                    <button v-for="track in subtitleTracks" :key="track.id" type="button" role="menuitemradio" :aria-checked="track.id === activeSubtitleTrackId" class="lmpl-afs-menuitem" @click="chooseSubtitles(track.id)">{{ track.label }}</button>
                                </div>
                            </div>

                            <button
                                v-if="isVideo && canPictureInPicture"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                :aria-label="messages.pictureInPicture"
                                data-test="afsPictureInPicture"
                                @click="emit('picture-in-picture')"
                            >
                                <media-icon name="pip-enter" class="media-button-icon"></media-icon>
                            </button>

                            <button
                                v-if="isVideo"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                :aria-label="messages.enterFullscreen"
                                data-test="afsFullscreen"
                                @click="emit('fullscreen')"
                            >
                                <media-icon name="fullscreen-enter" class="media-button-icon"></media-icon>
                            </button>

                            <slot name="cast"></slot>

                            <button
                                v-if="chapters.length > 1"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                :aria-label="messages.chapters"
                                data-test="afsChaptersButton"
                                @click="openChapters('chapters')"
                            >
                                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 6h10M10 12h10M10 18h10" /><rect x="3.5" y="4.5" width="3" height="3" rx="0.8" /><rect x="3.5" y="10.5" width="3" height="3" rx="0.8" fill="currentColor" /><rect x="3.5" y="16.5" width="3" height="3" rx="0.8" /></svg>
                            </button>

                            <button
                                v-if="hasBrowse"
                                type="button"
                                class="lmpl-afs-iconbtn"
                                                                :aria-label="messages.browse"
                                data-test="afsBrowse"
                                @click="openChapters()"
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
            :initial-tab="browseTab"
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
