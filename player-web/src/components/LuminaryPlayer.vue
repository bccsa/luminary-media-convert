<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { PlayerController } from '@luminary-media-converter/player-core';
import type {
    PlayerControllerApi,
    PlayerError,
    PlayerSource,
} from '@luminary-media-converter/player-core';
import { HlsJsAdapter } from '../adapter/HlsJsAdapter';
import { usePlayerState } from '../composables/usePlayerState';
import { useFullscreenOrientation } from '../composables/useFullscreenOrientation';
import { mergeMessages, type PlayerMessages } from '../messages';
import FullscreenControls from './FullscreenControls.vue';
import '../styles.css';

interface Props {
    /** What to play. Assigning a new object reloads the player. */
    source: PlayerSource;
    /**
     * Resolved UI strings merged over the built-in English defaults. Use this
     * for apps keeping the default surface; use the `coming-soon` / `error`
     * scoped slots to render your own instead.
     */
    messages?: Partial<PlayerMessages>;
    /**
     * @internal Test seam — substitutes controller construction. Not part of
     * the supported API; the default builds `PlayerController(HlsJsAdapter)`.
     */
    createController?: (video: HTMLVideoElement) => PlayerControllerApi;
}

const props = defineProps<Props>();

const containerEl = ref<HTMLElement | null>(null);
const videoEl = ref<HTMLVideoElement | null>(null);
const controller = shallowRef<PlayerControllerApi | null>(null);

const state = usePlayerState(controller);
const msg = computed(() => mergeMessages(props.messages));
const { isFullscreen, mode, enter, exit } = useFullscreenOrientation();

function defaultCreateController(video: HTMLVideoElement): PlayerControllerApi {
    return new PlayerController(new HlsJsAdapter(video));
}

onMounted(() => {
    const video = videoEl.value;
    if (!video) return;
    const create = props.createController ?? defaultCreateController;
    controller.value = create(video);
    void controller.value.load(props.source);
});

watch(
    () => props.source,
    (next) => {
        void controller.value?.load(next);
    },
);

onBeforeUnmount(() => {
    controller.value?.destroy();
    controller.value = null;
});

// --- error surface --------------------------------------------------------

const ERROR_MESSAGE_KEYS: Partial<Record<PlayerError['code'], keyof PlayerMessages>> = {
    'unsupported-browser': 'errorUnsupportedBrowser',
    'key-required': 'errorKeyRequired',
    network: 'errorNetwork',
    media: 'errorMedia',
};

const errorText = computed(() => {
    const code = state.value.error?.code;
    const key = code ? ERROR_MESSAGE_KEYS[code] : undefined;
    return key ? msg.value[key] : msg.value.errorGeneric;
});

function retry(): void {
    void controller.value?.load(props.source);
}

// --- fullscreen -----------------------------------------------------------

/** Custom controls are ours to draw only when we own the fullscreen element. */
const showCustomControls = computed(() => isFullscreen.value && mode.value === 'element');

async function enterFullscreen(): Promise<void> {
    const container = containerEl.value;
    const video = videoEl.value;
    if (!container || !video) return;
    try {
        await enter(container, video);
    } catch {
        /* denied by the browser (no user gesture, policy) — stay inline */
    }
}

function exitFullscreen(): void {
    void exit();
}

defineExpose({ controller, state, enterFullscreen, exitFullscreen });
</script>

<template>
    <div ref="containerEl" class="lmp-root" :class="{ 'lmp-is-fullscreen': isFullscreen }">
        <video ref="videoEl" class="lmp-video" playsinline webkit-playsinline></video>

        <div class="lmp-slot">
            <slot :state="state" :controller="controller"></slot>
        </div>

        <template v-if="state.lifecycle === 'waiting-for-master'">
            <slot name="coming-soon" :state="state">
                <div class="lmp-panel lmp-coming-soon">
                    <p class="lmp-panel-text">{{ msg.comingSoon }}</p>
                </div>
            </slot>
        </template>

        <template v-else-if="state.lifecycle === 'error'">
            <slot name="error" :state="state" :error="state.error" :retry="retry">
                <div class="lmp-panel lmp-error">
                    <p class="lmp-panel-text">{{ errorText }}</p>
                    <button type="button" class="lmp-btn lmp-retry" @click="retry">
                        {{ msg.retry }}
                    </button>
                </div>
            </slot>
        </template>

        <button
            v-if="!isFullscreen"
            type="button"
            class="lmp-icon-btn lmp-enter-fs"
            :aria-label="msg.enterFullscreen"
            :title="msg.enterFullscreen"
            @click="enterFullscreen"
        >
            <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9V4h5v2H6v3zM15 4h5v5h-2V6h-3zM6 15v3h3v2H4v-5zM18 15h2v5h-5v-2h3z" />
            </svg>
        </button>

        <FullscreenControls
            v-if="showCustomControls && controller"
            :state="state"
            :messages="msg"
            :controller="controller"
            @exit="exitFullscreen"
        />
    </div>
</template>
