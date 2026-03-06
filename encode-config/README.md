# @luminary-media-converter/encode-config

Vue 3 component for configuring HLS/ABR encoding parameters — video renditions, audio groups, codec settings, and stream copy options.

## Install

```bash
npm install @luminary-media-converter/encode-config
```

## Usage

```vue
<script setup lang="ts">
import { EncodeConfigForm } from '@luminary-media-converter/encode-config';
import type { ProbeResult, EncodeConfig } from '@luminary-media-converter/encode-config';

const probeResult: ProbeResult = {
    format: { duration: 120, bitrateKbps: 5000, formatName: 'matroska' },
    videoTracks: [
        { index: 0, codec: 'h264', width: 1920, height: 1080, bitrateKbps: 4500, frameRate: 24 },
    ],
    audioTracks: [
        { index: 1, codec: 'aac', bitrateKbps: 256, channels: 2, sampleRate: 48000 },
    ],
};

function onSubmit(config: EncodeConfig) {
    console.log('Encoding config:', config);
}

function onBack() {
    console.log('User clicked back');
}
</script>

<template>
    <EncodeConfigForm
        :probe-result="probeResult"
        :byte-range="false"
        @submit="onSubmit"
        @back="onBack"
    />
</template>
```

## Props

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `probeResult` | `ProbeResult` | Yes | Media analysis results (format info, video/audio tracks) |
| `byteRange` | `boolean` | Yes | When `true`, locks segment duration to 6s (byte-range HLS mode) |

## Events

| Event | Payload | Description |
|-------|---------|-------------|
| `submit` | `EncodeConfig` | Fired when the user submits the encoding configuration |
| `back` | — | Fired when the user confirms they want to go back (after deletion warning) |

## Styling

The component uses semantic CSS class names prefixed with `ecf-`. It ships with **no built-in styles** — you must provide CSS for these classes.

### Default stylesheet

A ready-made dark-theme stylesheet is included:

```ts
import '@luminary-media-converter/encode-config/styles.css';
```

### Custom styling

Override any `ecf-*` class in your own CSS. Key classes:

| Class | Element |
|-------|---------|
| `ecf-root` | Root container |
| `ecf-fieldset` | Section wrapper |
| `ecf-legend` | Section heading |
| `ecf-input` | Text/number inputs |
| `ecf-select` | Dropdowns |
| `ecf-card` | Rendition/audio group card |
| `ecf-btn-primary` | Submit button |
| `ecf-btn-secondary` | Back/cancel button |
| `ecf-btn-sm` | Small "Add" buttons |
| `ecf-btn-accent` | Accent action buttons |
| `ecf-btn-danger` | Destructive action button |
| `ecf-btn-remove` | Remove (X) icon button |
| `ecf-checkbox` | Checkbox inputs |
| `ecf-radio` | Radio inputs |
| `ecf-warning` | Warning text |
| `ecf-confirm-banner` | Confirmation dialog |
| `ecf-table` | Data tables |
| `ecf-info-panel` | Detected media summary |

Input size modifiers: `ecf-input-sm`, `ecf-input-xs`, `ecf-input-center`, `ecf-input-w20`, `ecf-input-w24`, `ecf-input-w28`, `ecf-input-w40`, `ecf-input-w48`, `ecf-input-segment`.

See [src/styles.css](src/styles.css) for the full list of classes and the default implementation.

## Utilities

Helper functions for persisting encoding configs in `localStorage`:

```ts
import { computeLayoutKey, getStoredConfig, saveConfig } from '@luminary-media-converter/encode-config';

// Generate a key based on media layout (track codecs, resolutions, channels)
const key = computeLayoutKey(probeResult, 'video');

// Retrieve a previously saved config
const saved = getStoredConfig(key);

// Save a config for later reuse
saveConfig(key, config);
```

## Types

All TypeScript interfaces are exported from the package entry point:

- `ProbeResult`, `FormatInfo`, `VideoTrackInfo`, `AudioTrackInfo` — media analysis types
- `EncodeConfig`, `VideoRendition`, `AudioGroup` — encoding configuration types
