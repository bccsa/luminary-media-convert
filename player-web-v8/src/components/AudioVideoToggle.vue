<script setup lang="ts">
/**
 * The audio / video toggle, top right of the picture.
 *
 * Visually the Luminary app's control — a two-half pill, film on the left,
 * musical note on the right, the active half darkened — but wired to
 * `player-core` rather than to a hand-built audio master: selecting the audio
 * side switches to the {@link AUDIO_ONLY_ANGLE_ID} pseudo-angle, whose munged
 * master carries zero video variants, so no video bytes are fetched at all.
 *
 * Switching back returns to the angle that was playing before, not to the
 * default one. On a multi-angle stream those are different, and sending a
 * viewer who was watching camera 2 back to camera 1 for having listened for a
 * minute is a change they did not ask for. The default angle is the fallback
 * for the only case where there is no previous one: audio was selected before
 * this component ever saw a video angle.
 */
import { computed, ref, watch } from 'vue';
import { AUDIO_ONLY_ANGLE_ID } from '@luminary-media-converter/player-core';
import type { PlayerControllerApi, PlayerState } from '@luminary-media-converter/player-core';
import type { PlayerMessages } from '../messages';

interface Props {
    state: Readonly<PlayerState>;
    /** null while the player is between sources; the control is inert then. */
    controller: PlayerControllerApi | null;
    messages: PlayerMessages;
}

const props = defineProps<Props>();

/**
 * `isAudioOnly` rather than the active angle id alone, so a stream that carries
 * no video at all shows the note lit rather than claiming to be playing a
 * picture that does not exist.
 */
const isAudio = computed(
    () => props.state.isAudioOnly || props.state.activeAngleId === AUDIO_ONLY_ANGLE_ID,
);

/** The last real angle seen playing — where the video half returns to. */
const previousAngleId = ref<string | null>(null);

watch(
    () => props.state.activeAngleId,
    (id) => {
        if (id && id !== AUDIO_ONLY_ANGLE_ID) previousAngleId.value = id;
    },
    { immediate: true },
);

function videoAngleTarget(): string | null {
    if (previousAngleId.value) return previousAngleId.value;
    const angles = props.state.angles.filter((angle) => angle.id !== AUDIO_ONLY_ANGLE_ID);
    return angles.find((angle) => angle.isDefault)?.id ?? angles[0]?.id ?? null;
}

function toggle(): void {
    const controller = props.controller;
    if (!controller) return;

    if (isAudio.value) {
        const target = videoAngleTarget();
        if (target) void controller.setAngle(target);
        return;
    }
    void controller.setAngle(AUDIO_ONLY_ANGLE_ID);
}
</script>

<template>
    <button
        type="button"
        class="lmpl-av-toggle"
        :aria-label="isAudio ? messages.videoModeLabel : messages.audioModeLabel"
        @click="toggle"
    >
        <span class="lmpl-av-half" :class="{ 'lmpl-av-half-active': !isAudio }">
            <!-- heroicons 24/outline "film" -->
            <svg
                class="lmpl-av-icon"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                stroke-width="1.5"
                stroke="currentColor"
                aria-hidden="true"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M3.375 19.5h17.25m-17.25 0a1.125 1.125 0 0 1-1.125-1.125M3.375 19.5h1.5C5.496 19.5 6 18.996 6 18.375m-3.75 0V5.625m0 12.75v-1.5c0-.621.504-1.125 1.125-1.125m18.375 2.625V5.625m0 12.75c0 .621-.504 1.125-1.125 1.125m1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125m0 3.75h-1.5A1.125 1.125 0 0 1 18 18.375M20.625 4.5H3.375m17.25 0c.621 0 1.125.504 1.125 1.125M20.625 4.5h-1.5C18.504 4.5 18 5.004 18 5.625m3.75 0v1.5c0 .621-.504 1.125-1.125 1.125M3.375 4.5c-.621 0-1.125.504-1.125 1.125M3.375 4.5h1.5C5.496 4.5 6 5.004 6 5.625m-3.75 0v1.5c0 .621.504 1.125 1.125 1.125m0 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125m1.5-3.75C5.496 8.25 6 7.746 6 7.125v-1.5M4.875 8.25C5.496 8.25 6 8.754 6 9.375v1.5m0-5.25v5.25m0-5.25C6 5.004 6.504 4.5 7.125 4.5h9.75c.621 0 1.125.504 1.125 1.125m1.125 2.625h1.5m-1.5 0A1.125 1.125 0 0 1 18 7.125v-1.5m1.125 2.625c-.621 0-1.125.504-1.125 1.125v1.5m2.625-2.625c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125M18 5.625v5.25M7.125 12h9.75m-9.75 0A1.125 1.125 0 0 1 6 10.875M7.125 12C6.504 12 6 12.504 6 13.125m0-2.25C6 11.496 5.496 12 4.875 12M18 10.875c0 .621-.504 1.125-1.125 1.125M18 10.875c0 .621.504 1.125 1.125 1.125m-2.25 0c.621 0 1.125.504 1.125 1.125m-12 5.25v-5.25m0 5.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125m-12 0v-1.5c0-.621-.504-1.125-1.125-1.125M18 18.375v-5.25m0 5.25v-1.5c0-.621.504-1.125 1.125-1.125M18 13.125v1.5c0 .621.504 1.125 1.125 1.125M18 13.125c0-.621.504-1.125 1.125-1.125M6 13.125v1.5c0 .621-.504 1.125-1.125 1.125M6 13.125C6 12.504 5.496 12 4.875 12m-1.5 0h1.5m-1.5 0c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125M19.125 12h1.5m0 0c.621 0 1.125.504 1.125 1.125v1.5c0 .621-.504 1.125-1.125 1.125m-17.25 0h1.5m14.25 0h1.5"
                />
            </svg>
        </span>
        <span class="lmpl-av-half" :class="{ 'lmpl-av-half-active': isAudio }">
            <!-- heroicons 24/solid "musical-note" -->
            <svg
                class="lmpl-av-icon"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
            >
                <path
                    fill-rule="evenodd"
                    d="M19.952 1.651a.75.75 0 0 1 .298.599V16.303a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.403-4.909l2.311-.66a1.5 1.5 0 0 0 1.088-1.442V6.994l-9 2.572v9.737a3 3 0 0 1-2.176 2.884l-1.32.377a2.553 2.553 0 1 1-1.402-4.909l2.31-.66a1.5 1.5 0 0 0 1.088-1.442V5.25a.75.75 0 0 1 .544-.721l10.5-3a.75.75 0 0 1 .658.122Z"
                    clip-rule="evenodd"
                />
            </svg>
        </span>
    </button>
</template>
