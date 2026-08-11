<script setup lang="ts">
import { computed } from 'vue';
import type { ThumbnailSpriteCue } from '@luminary-media-converter/player-core';

/**
 * One frame out of a sprite sheet.
 *
 * Drawn as a background offset rather than an `<img>`, because the frame is a
 * crop of a sheet holding many: the element is a window onto the sheet, and
 * moving to an adjacent frame costs no new request since it is the same image.
 *
 * The frame renders at the crop's own pixel size and the whole element is then
 * scaled to `width`. The alternative — scaling the background — needs the
 * sheet's total width to compute `background-size`, and a cue does not carry it.
 * Tile sizes differ between encodes, so anything assumed there misaligns on the
 * first sheet that does not match.
 */
const props = withDefaults(
    defineProps<{
        cue: ThumbnailSpriteCue;
        /** Displayed width in pixels. The frame scales to it, keeping its aspect. */
        width?: number;
        /** Timecode drawn under the frame. Omitted draws none. */
        label?: string;
    }>(),
    { width: 160 },
);

/** A cue with no `#xywh=` crop means the whole image is the frame. */
const isWholeImage = computed(() => !props.cue.w || !props.cue.h);

const scale = computed(() =>
    isWholeImage.value ? 1 : props.width / props.cue.w,
);

const frameStyle = computed(() => {
    const { spriteUrl, x, y, w, h } = props.cue;
    if (isWholeImage.value) {
        return {
            width: `${props.width}px`,
            aspectRatio: '16 / 9',
            backgroundImage: `url("${spriteUrl}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
        };
    }
    return {
        width: `${w}px`,
        height: `${h}px`,
        backgroundImage: `url("${spriteUrl}")`,
        backgroundSize: 'auto',
        backgroundPosition: `-${x}px -${y}px`,
        backgroundRepeat: 'no-repeat',
        transform: `scale(${scale.value})`,
        transformOrigin: 'bottom center',
    };
});

/**
 * Scaling with a transform leaves the element's *layout* box at the native crop
 * size, so a parent laying this out would reserve the wrong space. These are the
 * post-scale dimensions, for the wrapper to reserve instead.
 */
const boxStyle = computed(() => {
    if (isWholeImage.value) return {};
    return {
        width: `${Math.round(props.cue.w * scale.value)}px`,
        height: `${Math.round(props.cue.h * scale.value)}px`,
    };
});
</script>

<template>
    <div class="lmp-thumb" aria-hidden="true">
        <div class="lmp-thumb-box" :style="boxStyle">
            <div class="lmp-thumb-frame" :style="frameStyle"></div>
        </div>
        <span v-if="label" class="lmp-thumb-time">{{ label }}</span>
    </div>
</template>

<style>
.lmp-thumb {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    /* Never a target: it follows a pointer that is dragging something else. */
    pointer-events: none;
}

.lmp-thumb-box {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    overflow: hidden;
    border-radius: 6px;
    border: 1px solid rgb(255 255 255 / 0.35);
    background-color: #000;
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.55);
}

.lmp-thumb-frame {
    flex: none;
}

.lmp-thumb-time {
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 4px;
    color: #fff;
    background: rgb(0 0 0 / 0.66);
}
</style>
