# @luminary/encode-config

Vue 3 component library for building encoding configuration UIs on top of the [Luminary Encoding API](../api/README.md). It takes ffprobe-generated media analysis results (probe results) from the API and presents a user-friendly form for configuring FFmpeg-compatible HLS/ABR encoding settings — video renditions, audio groups, bitrate/resolution selection, copy/re-encode toggles, and VBR/CBR mode.

This package is designed for developers building custom web interfaces for the Encoding API. It handles the complexity of translating media track information into valid encoding configurations that the API accepts.

## Exports

- **`EncodeConfigForm`** -- Vue 3 component (Composition API, `<script setup>`) that displays probe results (detected video/audio tracks) and provides a configurable encoding form (video renditions, audio groups, copy/VBR toggles, ABR ladder suggestions)
- **Types** -- `ProbeResult`, `FormatInfo`, `VideoTrackInfo`, `AudioTrackInfo`, `EncodeConfig`, `VideoRendition`, `AudioGroup`
- **`layoutStorage`** -- `computeLayoutKey()`, `getStoredConfig()`, `saveConfig()` for persisting encoding configs keyed by media layout fingerprint (localStorage-backed)
- **`estimateEncodingCost`** -- Cost estimation utility (future)

## How It Works

1. A client uploads a media file to the Encoding API via the tus protocol
2. The Encoding API probes the file with ffprobe and returns a `ProbeResult` (detected video/audio tracks with codec, resolution, bitrate, language, etc.)
3. The `EncodeConfigForm` component takes this `ProbeResult` as input and renders an interactive configuration form
4. The component suggests an ABR ladder based on the source resolution and provides sensible defaults for audio groups
5. The user adjusts settings (add/remove renditions, toggle copy mode, select VBR/CBR, assign audio groups)
6. On submit, the component emits an `EncodeConfig` object that can be sent directly to the Encoding API's `POST /api/sessions/:id/encode` endpoint

The component also persists configs to localStorage keyed by media layout fingerprint, so users get their previous settings restored when encoding media with the same track layout.

## Peer Dependencies

- Vue 3

## Usage

```vue
<script setup lang="ts">
import { EncodeConfigForm } from '@luminary/encode-config';
import type { ProbeResult, EncodeConfig } from '@luminary/encode-config';

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
| `back` | -- | Fired when the user confirms they want to go back (after deletion warning) |

## Styling

The component uses semantic CSS class names prefixed with `ecf-`. It ships with **no built-in styles** -- you must provide CSS for these classes.

A ready-made dark-theme stylesheet is included:

```ts
import '@luminary/encode-config/styles.css';
```

See [src/styles.css](src/styles.css) for the full list of classes and the default implementation.

## Development

```bash
# Watch build (rebuilds on source changes)
npm -w encode-config run dev

# One-time build
npm -w encode-config run build
```

## Tech Stack

- Vue 3 (Composition API)
- Vite 6 (library mode)
- TypeScript
