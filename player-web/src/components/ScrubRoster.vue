<script setup lang="ts">
import { computed } from 'vue';
import type { ThumbnailSpriteCue } from '@luminary-media-converter/player-core';

/**
 * The strip of frames shown under the timeline while it is held: the stretch of the video around the
 * playhead, sliding past a marker that stays under the pointer.
 *
 * Each frame is a crop of a sprite sheet, drawn the way `ScrubThumbnail` draws one: a window the size of
 * the crop, scaled to the roster's height. A tile without a cue yet stays dark rather than leaving a hole.
 */
const props = defineProps<{
    tiles: { key: string; left: number; cue: ThumbnailSpriteCue | null }[];
    /** Each frame's width and the roster's height, in px. */
    tileWidth: number;
    height: number;
    /** Where the marker sits, in px from the roster's left. */
    markerX: number;
    /** Gap, in px, between the player's bottom edge and the roster's. */
    bottom: number;
    /** A pinned roster: it takes the pointer (to be dragged) and offers a button to close it. */
    interactive?: boolean;
    closeLabel?: string;
}>();

const emit = defineEmits<{ close: [] }>();

function tileStyle(tile: { left: number }) {
    return { left: `${tile.left}px`, width: `${props.tileWidth}px`, height: `${props.height}px` };
}

function frameStyle(cue: ThumbnailSpriteCue) {
    if (!cue.w || !cue.h) {
        return {
            width: '100%',
            height: '100%',
            backgroundImage: `url("${cue.spriteUrl}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        };
    }
    return {
        width: `${cue.w}px`,
        height: `${cue.h}px`,
        backgroundImage: `url("${cue.spriteUrl}")`,
        backgroundPosition: `-${cue.x}px -${cue.y}px`,
        backgroundRepeat: 'no-repeat',
        transform: `scale(${props.height / cue.h})`,
        transformOrigin: 'top left',
    };
}

const rosterStyle = computed(() => ({
    bottom: `${props.bottom}px`,
    height: `${props.height}px`,
    '--lmpl-marker': `${props.markerX}px`,
}));

const markerStyle = computed(() => ({ left: `${props.markerX}px` }));
</script>

<template>
    <div
        class="lmpl-roster"
        :class="{ 'lmpl-roster-interactive': interactive }"
        :style="rosterStyle"
        :aria-hidden="interactive ? undefined : 'true'"
    >
        <div v-for="tile in tiles" :key="tile.key" class="lmpl-roster-tile" :style="tileStyle(tile)">
            <div v-if="tile.cue" class="lmpl-roster-frame" :style="frameStyle(tile.cue)"></div>
        </div>
        <div class="lmpl-roster-vignette"></div>
        <div class="lmpl-roster-marker" :style="markerStyle"></div>
        <button
            v-if="interactive"
            type="button"
            class="lmpl-roster-close"
            :aria-label="closeLabel"
            :title="closeLabel"
            @pointerdown.stop
            @pointerup.stop
            @click.stop="emit('close')"
        >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
    </div>
</template>
