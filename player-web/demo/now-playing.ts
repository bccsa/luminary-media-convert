import '../src/generated/skin.css';
import '../src/styles.css';
import { computed, createApp, h, nextTick, onMounted, reactive, ref } from 'vue';
import AudioFullscreen from '../src/components/AudioFullscreen.vue';
import { DEFAULT_MESSAGES } from '../src/messages';
import clipUrl from '../../test-media/trim-test-1080p-4audio.mp4?url';

/**
 * The now-playing view as a host uses it for sound and picture: one video element that keeps playing, placed over
 * the view's stage with the picture and hidden with sound alone, as the app keeps its engine in place. Query string:
 * `wash=cover` blurs the cover instead of the ThumbHash-like wash; `hole=1` draws the picture behind the view, as the
 * native player does (the default; `hole=0` puts it over the view); `theme=light`; `start=audio`.
 */
const params = new URLSearchParams(location.search);

function paint(width: number, height: number, stops: string[]): string {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    stops.forEach((colour, i) => gradient.addColorStop(i / (stops.length - 1), colour));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    return canvas.toDataURL();
}
// A cover, and a few-pixel picture of its colours standing in for a decoded ThumbHash.
const cover = paint(600, 600, ['#4c9a9a', '#23494d', '#6a7b5f']);
const hashWash = paint(8, 8, ['#3d8a8c', '#1f4547', '#5d6d52']);

const lines = [
    'Out of the depths of my heart, Lord, I pray!',
    'Help me, Your Word to obey!',
    'Help me to love Your laws and way!',
    'Strengthen my will to do right every day.',
    'Keep me, O Lord, from the snares of the foe,',
    'Lead me the way I should go.',
    'Give me the courage to stand and be true,',
    'Faithful in all that I do.',
];
const lyrics = lines.map((text, i) => ({ start: 2 + i * 4, end: 6 + i * 4, text }));
const chapters = ['Welcome', 'Singing', 'Testimonies', 'The word'].map((title, i) => ({ startTime: i * 30, endTime: i * 30 + 30, title }));

createApp({
    setup() {
        const video = ref<HTMLVideoElement | null>(null);
        const state = reactive({ playing: false, currentTime: 0, duration: 0, rate: 1, subtitles: null as string | null, sleep: null as null | { kind: 'minutes'; minutes: number; endsAt: number } | { kind: 'chapter' } });
        const mode = ref<'audio' | 'video'>(params.get('start') === 'audio' ? 'audio' : 'video');
        // Behind the view, through its cut-out, as the native player draws it; `hole=0` puts it over the view instead.
        const hole = params.get('hole') !== '0';
        const stageBox = ref<{ top: number; left: number; width: number; height: number } | null>(null);

        // The picture follows the stage, wherever the layout puts it.
        function place(): void {
            const stage = document.querySelector<HTMLElement>("[data-test='afsStage']");
            const rect = stage?.getBoundingClientRect();
            stageBox.value = rect && mode.value === 'video' ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height } : null;
        }
        onMounted(() => {
            const el = video.value!;
            el.addEventListener('timeupdate', () => (state.currentTime = el.currentTime));
            el.addEventListener('loadedmetadata', () => (state.duration = el.duration));
            el.addEventListener('play', () => (state.playing = true));
            el.addEventListener('pause', () => (state.playing = false));
            new ResizeObserver(place).observe(document.body);
            window.addEventListener('resize', place);
            const tick = (): void => {
                place();
                requestAnimationFrame(tick);
            };
            tick();
        });
        const chapterIndex = computed(() => chapters.reduce((found, c, i) => (c.startTime <= state.currentTime ? i : found), -1));
        const caption = computed(() => {
            if (!state.subtitles || mode.value !== 'video') return '';
            const line = [...lyrics].reverse().find((l) => l.start <= state.currentTime && state.currentTime < l.end);
            return line?.text ?? '';
        });
        const seek = (t: number): void => {
            if (video.value) video.value.currentTime = Math.max(0, t);
        };
        const switchMode = async (next: 'audio' | 'video'): Promise<void> => {
            mode.value = next;
            await nextTick();
            place();
        };
        const pill = (active: boolean): string =>
            `border:0;border-radius:999px;padding:6px 12px;font:600 13px/1 system-ui;cursor:pointer;${active ? 'background:#f4f6f7;color:#10171c' : 'background:transparent;color:rgb(255 255 255/.7)'}`;

        return () =>
            h('div', { class: 'lmpl-root', style: 'position:fixed;inset:0;width:100%;height:100%;aspect-ratio:auto' }, [
                // The engine: one element, never moved, behind the view when it is "native".
                h('video', {
                    ref: video,
                    src: clipUrl,
                    playsinline: true,
                    loop: true,
                    style: {
                        position: 'fixed',
                        zIndex: hole ? 0 : 40,
                        objectFit: 'contain',
                        background: '#000',
                        ...(stageBox.value
                            ? { top: `${stageBox.value.top}px`, left: `${stageBox.value.left}px`, width: `${stageBox.value.width}px`, height: `${stageBox.value.height}px`, opacity: 1 }
                            : { top: '0', left: '0', width: '1px', height: '1px', opacity: 0, pointerEvents: 'none' }),
                    },
                }),
                caption.value && stageBox.value
                    ? h(
                          'div',
                          {
                              style: `position:fixed;z-index:41;left:${stageBox.value.left}px;width:${stageBox.value.width}px;top:${stageBox.value.top + stageBox.value.height - 34}px;text-align:center;pointer-events:none`,
                          },
                          [h('span', { style: 'background:rgb(0 0 0/.6);color:#fff;font:15px/1.3 system-ui;padding:2px 8px;border-radius:3px' }, caption.value)]
                      )
                    : null,
                h(
                    AudioFullscreen,
                    {
                        title: 'Youth meeting',
                        subtitle: 'Youth · 10 Oct 2026',
                        artwork: { src: cover },
                        wash: params.get('wash') === 'cover' ? undefined : hashWash,
                        appearance: params.get('theme') === 'light' ? 'light' : 'dark',
                        stage: mode.value === 'video' ? 'video' : 'cover',
                        stageHole: hole,
                        exitLabel: 'Minimise player',
                        chapters,
                        currentTime: state.currentTime,
                        duration: state.duration,
                        bufferedEnd: state.duration,
                        playing: state.playing,
                        chapterIndex: chapterIndex.value,
                        playbackRate: state.rate,
                        audioTracks: [
                            { id: 'en', label: 'English' },
                            { id: 'fr', label: 'Français' },
                        ],
                        activeAudioTrackId: 'en',
                        sleepTimer: state.sleep,
                        hasBrowse: true,
                        chaptersSheet: true,
                        upNext: [
                            { id: 'a', title: 'Sunday meeting', subtitle: '11 Oct 2026', section: 'Up next' },
                            { id: 'b', title: 'Worrying about everything, worried about nothing', subtitle: 'Podcast', section: 'Related' },
                        ],
                        subtitleTracks: [{ id: 'en', label: 'English' }],
                        activeSubtitleTrackId: state.subtitles,
                        canPictureInPicture: typeof document !== 'undefined' && 'pictureInPictureEnabled' in document,
                        lyrics,
                        skipBackSeconds: 10,
                        skipForwardSeconds: 10,
                        chapterMask: '',
                        messages: DEFAULT_MESSAGES,
                        onExit: () => alert('Minimise: in the app, the player goes to the mini bar here.'),
                        'onToggle-play': () => (state.playing ? video.value?.pause() : void video.value?.play()),
                        onSeek: seek,
                        'onSeek-chapter': (c: { startTime: number }) => seek(c.startTime),
                        onRate: (rate: number) => {
                            state.rate = rate;
                            if (video.value) video.value.playbackRate = rate;
                        },
                        'onAudio-track': () => undefined,
                        onSleep: (option: { kind: 'minutes'; minutes: number } | { kind: 'chapter' } | null) =>
                            (state.sleep = option === null ? null : option.kind === 'minutes' ? { ...option, endsAt: Date.now() + option.minutes * 60_000 } : option),
                        'onSubtitle-track': (id: string | null) => (state.subtitles = id),
                        'onPicture-in-picture': () => void video.value?.requestPictureInPicture?.().catch(() => undefined),
                        onFullscreen: () => void video.value?.requestFullscreen?.().catch(() => (video.value as unknown as { webkitEnterFullscreen?: () => void })?.webkitEnterFullscreen?.()),
                        onUpnextselect: () => undefined,
                    },
                    {
                        'top-end': () =>
                            h('div', { style: 'display:flex;background:rgb(255 255 255/.1);border-radius:999px;padding:3px;gap:2px' }, [
                                h('button', { type: 'button', style: pill(mode.value === 'audio'), onClick: () => switchMode('audio') }, '♪ Audio'),
                                h('button', { type: 'button', style: pill(mode.value === 'video'), onClick: () => switchMode('video') }, '▣ Video'),
                            ]),
                        stage: () => h('div', { 'aria-hidden': 'true' }),
                    }
                ),
            ]);
    },
}).mount('#app');
