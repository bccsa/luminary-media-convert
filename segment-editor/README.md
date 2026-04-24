# @luminary-media-converter/segment-editor

A player-agnostic Vue 3 timeline segment editor. Use it to:

- pick trim ranges for encoding
- author chapters (export as WebVTT)
- author subtitles (export as WebVTT)

Works with any video/audio player — you pass in `getCurrentTime()` and optional `onSeek` / `onPlayPause` callbacks.

## Install

```sh
npm install @luminary-media-converter/segment-editor
```

Peer dependency: `vue ^3.5`.

## Usage

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { SegmentEditor } from '@luminary-media-converter/segment-editor';
import type { Segment } from '@luminary-media-converter/segment-editor';
import '@luminary-media-converter/segment-editor/styles.css';

const segments = ref<Segment[]>([]);
const videoEl = ref<HTMLVideoElement | null>(null);
</script>

<template>
  <video ref="videoEl" src="/movie.mp4" controls />
  <SegmentEditor
    v-model="segments"
    mode="chapters"
    :duration="videoEl?.duration ?? 0"
    :get-current-time="() => videoEl?.currentTime ?? 0"
    :on-seek="(t) => { if (videoEl) videoEl.currentTime = t }"
    :on-play-pause="() => videoEl?.paused ? videoEl.play() : videoEl?.pause()"
  />
</template>
```

## Modes

| Mode         | Labels | Overlap | Ripple edit | VTT export        |
|--------------|--------|---------|-------------|-------------------|
| `trim`       | hidden | forbidden | off       | —                 |
| `chapters`   | shown  | forbidden | on (default) | `exportChaptersVtt`  |
| `subtitles`  | shown  | allowed | off         | `exportSubtitlesVtt` |

Override the mode-derived defaults with `show-labels`, `allow-overlap`, or `ripple-edit` props.

## Props

| Prop                  | Type                                    | Default   | Notes |
|-----------------------|-----------------------------------------|-----------|-------|
| `modelValue`          | `Segment[]`                             | required  | Use `v-model`. |
| `duration`            | `number`                                | required  | Seconds. |
| `getCurrentTime`      | `() => number`                          | required  | Called every RAF tick. |
| `onSeek`              | `(seconds: number) => void`             | —         | Enables click-to-seek, drag-scrub, keyboard step. |
| `onPlayPause`         | `() => void`                            | —         | Enables Space / K shortcuts and the play button. |
| `isPlaying`           | `boolean`                               | `false`   | Updates the play/pause button icon. |
| `mode`                | `'trim' \| 'chapters' \| 'subtitles'`   | `'trim'`  | |
| `showLabels`          | `boolean`                               | mode-dependent | |
| `allowOverlap`        | `boolean`                               | mode-dependent | |
| `rippleEdit`          | `boolean`                               | `true`    | Chapters only. Pushes neighbors to fit. |
| `minSegmentSec`       | `number`                                | `0.2`     | |
| `snapSec`             | `number`                                | `0.25`    | Snap distance; `0` disables snapping. |
| `keyboardScope`       | `'focus' \| 'global' \| 'off'`          | `'focus'` | `focus` only handles keys when the timeline has focus. |
| `throttleSeekMs`      | `number`                                | `33`      | Cap for `onSeek` emissions while scrubbing (~30 Hz). |
| `fps`                 | `number`                                | `0`       | Enables frame stepping with `,` / `.`. |
| `showToolbar`         | `boolean`                               | `true`    | |
| `showPlaybackControls`| `boolean`                               | `true`    | Only renders when `onSeek` or `onPlayPause` is set. |
| `showList`            | `boolean`                               | `true`    | |
| `showHelp`            | `boolean`                               | `true`    | |
| `maxZoom`             | `number`                                | `40`      | |
| `title`               | `string`                                | —         | Override the panel heading. |

## Emits

| Event              | Payload            | Fires when |
|--------------------|--------------------|-----------|
| `update:modelValue`| `Segment[]`        | Any mutation. |
| `select`           | `string[]`         | Selection changes (segment ids). |
| `seek`             | `number`           | The editor wants the player to seek. Also delivered via `onSeek` prop. |
| `segment-commit`   | `Segment[]`        | After a drag, mark in/out, add, or remove — i.e., a user-intentioned commit (not every keystroke). |

## Slots

| Slot              | Position                                                              |
|-------------------|-----------------------------------------------------------------------|
| `playback-start`  | Left cell of the playback-controls row. Ideal for an audio-track selector or other player-adjacent UI. |
| `playback-end`    | Right cell of the playback-controls row. Ideal for a quality selector. |

The center cell of the playback row always holds the `[← back] [▶/⏸] [→ forward]` group. Current time is rendered on its own line above the timeline.

## Exposed methods

```ts
const editor = ref<InstanceType<typeof SegmentEditor> | null>(null);

editor.value?.markIn();
editor.value?.markOut();
editor.value?.addSegment();
editor.value?.clearAll();
editor.value?.undo();
editor.value?.redo();
editor.value?.zoomTo(startSec, endSec);
editor.value?.exportVtt();        // chapters/subtitles flavor depends on mode
editor.value?.importVtt(text);
editor.value?.focus();
```

## Keyboard shortcuts

Active when the timeline has focus (or globally if `keyboardScope="global"`).

| Keys                   | Action                                              |
|------------------------|-----------------------------------------------------|
| Space / K              | Play / pause                                        |
| ← / →                  | Step 1 s back / forward                             |
| hold 1 / 2 / 3 + arrow | Step 10 s / 30 s / 60 s                             |
| J / L                  | Step 10 s back / forward                            |
| , / .                  | Step one frame (when `fps` is set)                  |
| [                      | Mark In at playhead                                 |
| ]                      | Mark Out at playhead                                |
| Alt + ← / →            | Nudge the selected segment's nearest edge           |
| Delete / Backspace     | Remove selected segment(s)                          |
| ⌘ / Ctrl + Z           | Undo                                                |
| ⌘ / Ctrl + Shift + Z   | Redo                                                |
| + / −                  | Zoom in / out                                       |
| 0                      | Reset zoom                                          |
| Ctrl / ⌘ + wheel       | Zoom at cursor                                      |
| Shift + drag           | Marquee-select segments                             |
| Esc                    | Clear selection / close help                        |
| ?                      | Toggle keyboard help overlay                        |

## WebVTT helpers

Exported as pure functions — usable outside the component:

```ts
import {
  exportChaptersVtt,
  exportSubtitlesVtt,
  parseVtt,
  formatVttTimestamp,
  parseVttTimestamp,
} from '@luminary-media-converter/segment-editor';
```

## Theming

All colors come from CSS custom properties on `.se-root`. Override them in your app:

```css
.se-root {
  --se-accent: #10b981;
  --se-bg: #0a0a0a;
  --se-track: #1f2937;
}
```

See [`src/styles.css`](src/styles.css) for the full list.

## Touch

Pinch-to-zoom and horizontal swipe-to-pan work on trackpads and touch screens.

## Future features

Planned for later releases:

- **Waveform layer** — optional audio waveform under the timeline, driven by a `waveform-peaks` prop (decoder-agnostic: consumer supplies pre-computed peaks).

## License

Apache-2.0.
