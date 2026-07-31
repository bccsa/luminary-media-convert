<script setup lang="ts">
import { reactive, computed, ref, watch } from 'vue';
import type {
    ProbeResult,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
    AudioTrackInfo,
    VideoTrackInfo,
} from './types';
import { computeLayoutKey, getStoredConfig } from './layoutStorage';
import { fpsAdjustedBitrateKbps } from './ladder';
import {
    buildSuggestedAudioGroups,
    getAudioTierForHeight,
} from './audioGroups';

const props = withDefaults(
    defineProps<{
        probeResult: ProbeResult;
        byteRange: boolean;
        /** When `next-to-trim`, primary CTA navigates to trim instead of submitting encode. */
        encodePrimaryAction?: 'start-encoding' | 'next-to-trim';
        /** `session` — light slate panels for embedding in the web app session card. */
        appearance?: 'default' | 'session';
    }>(),
    { encodePrimaryAction: 'start-encoding', appearance: 'default' }
);

const emit = defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
    'next-to-trim': [];
    'can-submit-change': [valid: boolean];
}>();

const encodingType = reactive<{ value: 'video' | 'audio' }>({
    value: props.probeResult.videoTracks.length > 0 ? 'video' : 'audio',
});

const segmentDuration = reactive<{ value: number }>({
    value: 6,
});

const videoRenditions = reactive<VideoRendition[]>([]);

const audioGroups = reactive<AudioGroup[]>([]);

const editableVideoTracks = reactive<VideoTrackInfo[]>(
    props.probeResult.videoTracks.map((t) => ({ ...t }))
);

const editableAudioTracks = reactive<AudioTrackInfo[]>(
    props.probeResult.audioTracks.map((t) => ({ ...t }))
);

/** Source track picker shown whenever there are multiple video tracks to choose from. */
const showVideoRenditionSourceColumn = computed(
    () => editableVideoTracks.length > 1
);

const ABR_LADDER = [
    { height: 2160, width: 3840, bitrateKbps: 15000, label: '4K' },
    { height: 1440, width: 2560, bitrateKbps: 8000, label: '1440p' },
    { height: 1080, width: 1920, bitrateKbps: 5000, label: '1080p' },
    { height: 720, width: 1280, bitrateKbps: 2500, label: '720p' },
    { height: 480, width: 854, bitrateKbps: 1000, label: '480p' },
    { height: 360, width: 640, bitrateKbps: 600, label: '360p' },
    { height: 240, width: 426, bitrateKbps: 300, label: '240p' },
    { height: 144, width: 256, bitrateKbps: 150, label: '144p' },
];

// Derive a rendition width from a target height that preserves the source's
// aspect ratio, rounded to an even number (H.264/yuv420p requires even
// dimensions). For a 16:9 source this reproduces the ABR_LADDER widths exactly;
// for non-standard ratios (4:3, 21:9, portrait, …) it avoids stretching the
// picture into 16:9. Returns at least 2.
function aspectWidthForHeight(
    height: number,
    sourceWidth: number,
    sourceHeight: number
): number {
    if (!sourceWidth || !sourceHeight) return height;
    // Round to the nearest even number — this reproduces the canonical 16:9
    // ladder widths exactly (e.g. 480p → 854, 240p → 426) while keeping every
    // dimension even, as H.264/yuv420p requires.
    const width = Math.round((height * sourceWidth) / sourceHeight / 2) * 2;
    return Math.max(2, width);
}

function mapTierToGroupId(standardGroupId: string, tierIds: string[]): string {
    if (tierIds.includes(standardGroupId)) return standardGroupId;
    const tierIndex =
        standardGroupId === 'hd' ? 0 : standardGroupId === 'mid' ? 1 : 2;
    return (
        tierIds[Math.min(tierIndex, tierIds.length - 1)] ??
        tierIds[0] ??
        'tier_0'
    );
}

function reanalyzeVideo() {
    const sortedVideoTracks = [...editableVideoTracks].sort(
        (a, b) => b.height * b.width - a.height * a.width
    );

    const newGroups = buildSuggestedAudioGroups(
        editableAudioTracks,
        sortedVideoTracks.length
    );
    const tierIds = [...new Set(newGroups.map((g) => g.id))];
    audioGroups.splice(0, audioGroups.length, ...newGroups);

    if (sortedVideoTracks.length > 1) {
        const newRenditions: VideoRendition[] = sortedVideoTracks.map(
            (track) => {
                const tier = getAudioTierForHeight(track.height);
                const audioGroupId = mapTierToGroupId(tier.groupId, tierIds);
                return {
                    width: track.width,
                    height: track.height,
                    videoBitrateKbps: track.bitrateKbps || 1000,
                    copyStream: true,
                    sourceTrackIndex: track.index,
                    audioGroupId,
                    label: track.name ?? `Track ${track.index}`,
                    vbr: true,
                };
            }
        );
        videoRenditions.splice(0, videoRenditions.length, ...newRenditions);
    } else if (sortedVideoTracks.length === 1) {
        const track = sortedVideoTracks[0];
        const ladder = ABR_LADDER.filter((r) => r.height <= track.height);
        if (ladder.length === 0) {
            ladder.push({
                height: track.height,
                width: track.width,
                bitrateKbps: track.bitrateKbps || 1000,
                label: `${track.height}p`,
            });
        }
        const newRenditions: VideoRendition[] = ladder.map((rung) => {
            const tier = getAudioTierForHeight(rung.height);
            const audioGroupId = mapTierToGroupId(tier.groupId, tierIds);
            return {
                width: aspectWidthForHeight(
                    rung.height,
                    track.width,
                    track.height
                ),
                height: rung.height,
                videoBitrateKbps: fpsAdjustedBitrateKbps(rung.bitrateKbps, track.frameRate ?? 30),
                copyStream: false,
                audioGroupId,
                vbr: true,
            };
        });
        videoRenditions.splice(0, videoRenditions.length, ...newRenditions);
    }
}

function reanalyzeAudio() {
    audioGroups.splice(
        0,
        audioGroups.length,
        ...buildSuggestedAudioGroups(editableAudioTracks, 0)
    );
}

function reanalyze() {
    if (encodingType.value === 'audio') {
        reanalyzeAudio();
    } else {
        reanalyzeVideo();
    }
}

reanalyze();

{
    const savedConfig = getStoredConfig(
        computeLayoutKey(props.probeResult, encodingType.value)
    );
    if (savedConfig) {
        if (savedConfig.videoTrackNames) {
            const nameMap = new Map(
                savedConfig.videoTrackNames.map((t) => [t.index, t.name])
            );
            for (const t of editableVideoTracks) {
                const saved = nameMap.get(t.index);
                if (saved != null) t.name = saved;
            }
        }
        if (savedConfig.audioTrackMetadata) {
            const audioMetaMap = new Map(
                savedConfig.audioTrackMetadata.map((m) => [
                    m.index,
                    { name: m.name, language: m.language },
                ])
            );
            for (const t of editableAudioTracks) {
                const saved = audioMetaMap.get(t.index);
                if (saved) {
                    if (saved.name !== undefined) t.name = saved.name;
                    if (saved.language !== undefined)
                        t.language = saved.language;
                }
            }
        }
        reanalyze();
    }
}

const uniqueAudioGroupOptions = computed(() => {
    const seen = new Set<string>();
    const result: { id: string; label: string }[] = [];
    for (const g of audioGroups) {
        if (!seen.has(g.id)) {
            seen.add(g.id);
            const groupEntries = audioGroups.filter((e) => e.id === g.id);
            const langs = groupEntries
                .map((e) => e.language ?? e.label ?? e.id)
                .join(', ');
            result.push({ id: g.id, label: `${g.id} (${langs})` });
        }
    }
    return result;
});

const layoutKey = computed(() =>
    computeLayoutKey(props.probeResult, encodingType.value)
);

const hasPreviousConfig = computed(
    () => getStoredConfig(layoutKey.value) != null
);

function loadPreviousTrackLabels() {
    const config = getStoredConfig(layoutKey.value);
    if (!config) return;

    if (config.videoTrackNames) {
        const nameMap = new Map(
            config.videoTrackNames.map((t) => [t.index, t.name])
        );
        for (const t of editableVideoTracks) {
            const saved = nameMap.get(t.index);
            if (saved != null) t.name = saved;
        }
    }

    if (config.audioTrackMetadata) {
        const audioMetaMap = new Map(
            config.audioTrackMetadata.map((m) => [
                m.index,
                { name: m.name, language: m.language },
            ])
        );
        for (const t of editableAudioTracks) {
            const saved = audioMetaMap.get(t.index);
            if (saved) {
                if (saved.name !== undefined) t.name = saved.name;
                if (saved.language !== undefined) t.language = saved.language;
            }
        }
    }
}

function addVideoRendition() {
    const defaultGroupId = audioGroups[0]?.id ?? 'hd';
    videoRenditions.push({
        width: 854,
        height: 480,
        videoBitrateKbps: 1000,
        copyStream: false,
        audioGroupId: defaultGroupId,
        label: '480p',
        vbr: true,
    });
}

function removeVideoRendition(index: number) {
    if (videoRenditions.length > 1) videoRenditions.splice(index, 1);
}

function addAudioGroup() {
    const id = `group_${Date.now()}`;
    audioGroups.push({
        id,
        label: 'New Audio',
        audioBitrateKbps: 128,
        channels: 2,
        audioCodec: 'aac',
        sourceTrackIndex: 0,
        vbr: true,
    });
}

function removeAudioGroup(index: number) {
    if (audioGroups.length > 1) audioGroups.splice(index, 1);
}

function onVbrToggle(g: AudioGroup) {
    if (g.vbr) {
        g.copyStream = false;
    } else if (g.audioBitrateKbps < 100) {
        g.channels = 1;
    }
}

function onCopyToggle(rendition: VideoRendition) {
    if (rendition.copyStream) {
        rendition.vbr = false;
        if (editableVideoTracks.length > 0) {
            const track = editableVideoTracks[rendition.sourceTrackIndex ?? 0];
            if (track) {
                rendition.width = track.width;
                rendition.height = track.height;
                rendition.videoBitrateKbps =
                    track.bitrateKbps || rendition.videoBitrateKbps;
            }
        }
    }
}

function onCopySourceChange(rendition: VideoRendition) {
    if (rendition.copyStream && rendition.sourceTrackIndex != null) {
        const track = editableVideoTracks[rendition.sourceTrackIndex];
        if (track) {
            rendition.width = track.width;
            rendition.height = track.height;
            rendition.videoBitrateKbps =
                track.bitrateKbps || rendition.videoBitrateKbps;
            rendition.label = track.name ?? `${track.height}p`;
        }
    }
}

function formatDuration(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function onTrackInputKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLInputElement;
    if (!target?.hasAttribute?.('data-track-field')) return;
    const row = parseInt(target.getAttribute('data-row') ?? '-1', 10);
    const col = parseInt(target.getAttribute('data-col') ?? '-1', 10);
    if (row < 0 || col < 0) return;

    const fieldset = target.closest('fieldset');
    if (!fieldset) return;
    const inputs = Array.from(
        fieldset.querySelectorAll<HTMLInputElement>(
            'input[data-track-field][data-row][data-col]'
        )
    );
    const rows =
        Math.max(
            ...inputs.map((el) =>
                parseInt(el.getAttribute('data-row') ?? '0', 10)
            ),
            0
        ) + 1;
    const cols =
        Math.max(
            ...inputs.map((el) =>
                parseInt(el.getAttribute('data-col') ?? '0', 10)
            ),
            0
        ) + 1;

    let nextRow = row;
    let nextCol = col;
    if (e.key === 'ArrowDown') {
        nextRow = Math.min(row + 1, rows - 1);
    } else if (e.key === 'ArrowUp') {
        nextRow = Math.max(row - 1, 0);
    } else if (e.key === 'ArrowRight') {
        nextCol = Math.min(col + 1, cols - 1);
    } else if (e.key === 'ArrowLeft') {
        nextCol = Math.max(col - 1, 0);
    } else {
        return;
    }
    if (nextRow === row && nextCol === col) return;

    e.preventDefault();
    const next = inputs.find(
        (el) =>
            parseInt(el.getAttribute('data-row') ?? '-1', 10) === nextRow &&
            parseInt(el.getAttribute('data-col') ?? '-1', 10) === nextCol
    );
    if (next) {
        next.focus();
        next.select();
    }
}

function channelLabel(ch: number): string {
    if (ch === 1) return 'Mono';
    if (ch === 2) return 'Stereo';
    if (ch === 6) return '5.1';
    if (ch === 8) return '7.1';
    return `${ch}ch`;
}

const canSubmit = computed(() => {
    if (encodingType.value === 'video') {
        if (videoRenditions.length === 0 || audioGroups.length === 0)
            return false;
        const groupIds = new Set(audioGroups.map((g) => g.id));
        return (
            videoRenditions.every(
                (r) =>
                    r.width > 0 &&
                    r.height > 0 &&
                    r.videoBitrateKbps > 0 &&
                    groupIds.has(r.audioGroupId) &&
                    (!r.copyStream || r.sourceTrackIndex != null)
            ) && audioGroups.every((g) => g.audioBitrateKbps > 0)
        );
    }
    return (
        audioGroups.length > 0 &&
        audioGroups.every((g) => g.audioBitrateKbps > 0)
    );
});

watch(
    canSubmit,
    (valid) => {
        emit('can-submit-change', valid);
    },
    { immediate: true }
);

function buildEncodeConfig(): EncodeConfig | null {
    if (!canSubmit.value) return null;

    const config: EncodeConfig = {
        type: encodingType.value,
        segmentDuration: props.byteRange ? 6 : segmentDuration.value,
    };

    if (encodingType.value === 'video') {
        config.videoRenditions = videoRenditions.map((r) => ({ ...r }));
        config.audioGroups = audioGroups.map((g) => ({ ...g }));
        config.videoTrackNames = editableVideoTracks.map((t) => ({
            index: t.index,
            name: ((t.name || `Angle ${t.index}`).trim() ||
                `Angle ${t.index}`) as string,
        }));
        config.audioTrackMetadata = editableAudioTracks.map((t) => ({
            index: t.index,
            name: t.name,
            language: t.language,
        }));
    } else {
        config.audioGroups = audioGroups.map((g) => ({ ...g }));
        config.audioTrackMetadata = editableAudioTracks.map((t) => ({
            index: t.index,
            name: t.name,
            language: t.language,
        }));
    }

    return config;
}

function onSubmit() {
    const config = buildEncodeConfig();
    if (config) emit('submit', config);
}

function onNextToTrim() {
    if (buildEncodeConfig() != null) emit('next-to-trim');
}

function getCanSubmit(): boolean {
    return canSubmit.value;
}

defineExpose({ editableAudioTracks, buildEncodeConfig, getCanSubmit });
</script>

<template>
    <div
        class="ecf-root"
        :class="{ 'ecf-root--session': props.appearance === 'session' }"
    >
        <!-- ① Mode card pair + optional segment duration -->
        <div class="ecf-modebar">
            <div class="ecf-mode-wrap">
                <span class="ecf-mode-label">Output mode</span>
                <div
                    class="ecf-mode-cards"
                    role="radiogroup"
                    aria-label="Output encoding mode"
                >
                    <button
                        type="button"
                        role="radio"
                        :aria-checked="encodingType.value === 'video'"
                        :class="[
                            'ecf-mode-card',
                            encodingType.value === 'video' &&
                                'ecf-mode-card--on',
                        ]"
                        :disabled="editableVideoTracks.length === 0"
                        :title="
                            editableVideoTracks.length === 0
                                ? 'No video tracks detected'
                                : undefined
                        "
                        @click="encodingType.value = 'video'"
                    >
                        <span class="ecf-mode-card__title">Video</span>
                        <span class="ecf-mode-card__check" aria-hidden="true">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="3"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <path d="M5 12l5 5 9-11" />
                            </svg>
                        </span>
                    </button>
                    <button
                        type="button"
                        role="radio"
                        :aria-checked="encodingType.value === 'audio'"
                        :class="[
                            'ecf-mode-card',
                            encodingType.value === 'audio' &&
                                'ecf-mode-card--on',
                        ]"
                        @click="encodingType.value = 'audio'"
                    >
                        <span class="ecf-mode-card__title">Audio only</span>
                        <span class="ecf-mode-card__check" aria-hidden="true">
                            <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="3"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                            >
                                <path d="M5 12l5 5 9-11" />
                            </svg>
                        </span>
                    </button>
                </div>
            </div>
            <div v-if="!byteRange" class="ecf-seg-ctrl">
                <label class="ecf-seg-lbl" for="ecf-seg-dur">Segment</label>
                <input
                    id="ecf-seg-dur"
                    v-model.number="segmentDuration.value"
                    type="number"
                    min="1"
                    class="ecf-input ecf-input-num"
                    title="HLS segment duration in seconds"
                />
                <span class="ecf-seg-lbl" aria-hidden="true">s</span>
            </div>
        </div>

        <!-- ② Detected Media — collapsible reference panel -->
        <details class="ecf-detect" open>
            <summary class="ecf-detect-summary">
                <svg
                    class="ecf-detect-chevron"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M19 9l-7 7-7-7"
                    />
                </svg>
                <span class="ecf-detect-title">Detected Media</span>
                <span class="ecf-detect-meta"
                    >{{ probeResult.format.formatName }} ·
                    {{ formatDuration(probeResult.format.duration) }} ·
                    {{ probeResult.format.bitrateKbps }} kbps</span
                >
                <span
                    v-if="editableVideoTracks.length > 0"
                    class="ecf-detect-badge ecf-detect-badge--video"
                    >{{ editableVideoTracks.length }} video</span
                >
                <span
                    v-if="editableAudioTracks.length > 0"
                    class="ecf-detect-badge ecf-detect-badge--audio"
                    >{{ editableAudioTracks.length }} audio</span
                >
                <button
                    v-if="hasPreviousConfig"
                    type="button"
                    class="ecf-btn-accent ecf-detect-action"
                    @click.stop.prevent="loadPreviousTrackLabels"
                >
                    Load saved track labels
                </button>
            </summary>
            <fieldset class="ecf-detect-body ecf-fieldset">
                <div v-if="editableVideoTracks.length > 0">
                    <p class="ecf-detect-sub">Angle</p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-table">
                            <thead class="ecf-thead">
                                <tr>
                                    <th class="ecf-th">#</th>
                                    <th class="ecf-th">Codec</th>
                                    <th class="ecf-th">Resolution</th>
                                    <th class="ecf-th">Bitrate</th>
                                    <th class="ecf-th">FPS</th>
                                    <th class="ecf-th">Angle</th>
                                </tr>
                            </thead>
                            <tbody class="ecf-tbody">
                                <tr
                                    v-for="t in editableVideoTracks"
                                    :key="t.index"
                                    class="ecf-tr"
                                >
                                    <td class="ecf-td">{{ t.index }}</td>
                                    <td class="ecf-td">
                                        {{ t.codec
                                        }}{{
                                            t.profile ? ` (${t.profile})` : ''
                                        }}
                                    </td>
                                    <td class="ecf-td">
                                        {{ t.width }}&times;{{ t.height }}
                                    </td>
                                    <td class="ecf-td">
                                        {{
                                            t.bitrateKbps
                                                ? `${t.bitrateKbps} kbps`
                                                : '—'
                                        }}
                                    </td>
                                    <td class="ecf-td">{{ t.frameRate }}</td>
                                    <td class="ecf-td">
                                        <input
                                            v-model="t.name"
                                            type="text"
                                            class="ecf-input ecf-input-sm"
                                            placeholder="e.g. Main angle"
                                            data-track-field="video-name"
                                            :data-track-index="t.index"
                                            :data-row="t.index"
                                            data-col="0"
                                            @keydown="onTrackInputKeydown"
                                        />
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <div v-if="editableAudioTracks.length > 0">
                    <p class="ecf-detect-sub">Audio tracks</p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-table">
                            <thead class="ecf-thead">
                                <tr>
                                    <th class="ecf-th">#</th>
                                    <th class="ecf-th">Codec</th>
                                    <th class="ecf-th">Bitrate</th>
                                    <th class="ecf-th">Channels</th>
                                    <th class="ecf-th">Sample Rate</th>
                                    <th class="ecf-th">Language</th>
                                    <th class="ecf-th">Name</th>
                                </tr>
                            </thead>
                            <tbody class="ecf-tbody">
                                <tr
                                    v-for="(t, audioIdx) in editableAudioTracks"
                                    :key="t.index"
                                    class="ecf-tr"
                                >
                                    <td class="ecf-td">{{ t.index }}</td>
                                    <td class="ecf-td">{{ t.codec }}</td>
                                    <td class="ecf-td">
                                        {{
                                            t.bitrateKbps
                                                ? `${t.bitrateKbps} kbps`
                                                : '—'
                                        }}
                                    </td>
                                    <td class="ecf-td">
                                        {{ channelLabel(t.channels) }}
                                    </td>
                                    <td class="ecf-td">
                                        {{ t.sampleRate }} Hz
                                    </td>
                                    <td class="ecf-td">
                                        <input
                                            v-model="t.language"
                                            type="text"
                                            class="ecf-input ecf-input-xs ecf-input-center"
                                            placeholder="und"
                                            data-track-field="audio-language"
                                            :data-track-index="t.index"
                                            :data-row="
                                                editableVideoTracks.length +
                                                audioIdx
                                            "
                                            data-col="0"
                                            @keydown="onTrackInputKeydown"
                                        />
                                    </td>
                                    <td class="ecf-td">
                                        <input
                                            v-model="t.name"
                                            type="text"
                                            class="ecf-input ecf-input-sm"
                                            placeholder="e.g. Commentary"
                                            data-track-field="audio-name"
                                            :data-track-index="t.index"
                                            :data-row="
                                                editableVideoTracks.length +
                                                audioIdx
                                            "
                                            data-col="1"
                                            @keydown="onTrackInputKeydown"
                                        />
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                <div
                    v-if="
                        encodingType.value === 'video' &&
                        (editableVideoTracks.length > 0 ||
                            editableAudioTracks.length > 0)
                    "
                >
                    <button
                        type="button"
                        class="ecf-btn-accent"
                        @click="reanalyze"
                    >
                        Re-analyze Mapping
                    </button>
                </div>
            </fieldset>
        </details>

        <!-- ③ Encoding ladder -->
        <div class="ecf-ladder-stack">
            <!-- Video Renditions (video mode only) -->
            <details
                v-if="encodingType.value === 'video'"
                class="ecf-panel"
                open
            >
                <summary class="ecf-panel-summary">
                    <svg
                        class="ecf-panel-chevron"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M19 9l-7 7-7-7"
                        />
                    </svg>
                    <span class="ecf-detect-title">Video Renditions</span>
                    <span class="ecf-detect-meta"
                        >{{ videoRenditions.length }} variant{{
                            videoRenditions.length === 1 ? '' : 's'
                        }}</span
                    >
                </summary>
                <div class="ecf-panel-body">
                    <p class="ecf-box-hint">One row per HLS variant stream</p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-lt">
                            <thead class="ecf-lt-thead">
                                <tr>
                                    <th
                                        v-if="showVideoRenditionSourceColumn"
                                        class="ecf-lt-th"
                                    >
                                        Source track
                                    </th>
                                    <th class="ecf-lt-th">Resolution</th>
                                    <th class="ecf-lt-th ecf-lt-th--r">kbps</th>
                                    <th class="ecf-lt-th">Audio group</th>
                                    <th class="ecf-lt-th">Angle</th>
                                    <th class="ecf-lt-th">Options</th>
                                    <th class="ecf-lt-th ecf-lt-th--del"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <template
                                    v-for="(r, i) in videoRenditions"
                                    :key="i"
                                >
                                    <tr class="ecf-lt-tr">
                                        <td
                                            v-if="
                                                showVideoRenditionSourceColumn
                                            "
                                            class="ecf-lt-td"
                                        >
                                            <select
                                                v-model.number="
                                                    r.sourceTrackIndex
                                                "
                                                class="ecf-select ecf-select-src"
                                                @change="onCopySourceChange(r)"
                                            >
                                                <option
                                                    v-for="t in editableVideoTracks"
                                                    :key="t.index"
                                                    :value="t.index"
                                                >
                                                    #{{ t.index
                                                    }}{{
                                                        t.name
                                                            ? ` — ${t.name}`
                                                            : ''
                                                    }}
                                                    ({{ t.width }}&times;{{
                                                        t.height
                                                    }},
                                                    {{
                                                        t.bitrateKbps != null &&
                                                        t.bitrateKbps > 0
                                                            ? `${t.bitrateKbps} kbps`
                                                            : 'bitrate n/a'
                                                    }})
                                                </option>
                                            </select>
                                        </td>
                                        <td class="ecf-lt-td">
                                            <span
                                                v-if="r.copyStream"
                                                class="ecf-cell-dim"
                                                >auto</span
                                            >
                                            <span v-else class="ecf-res-pair">
                                                <input
                                                    v-model.number="r.width"
                                                    type="number"
                                                    min="1"
                                                    class="ecf-input ecf-input-res"
                                                    title="Width px"
                                                />
                                                <span class="ecf-res-x">×</span>
                                                <input
                                                    v-model.number="r.height"
                                                    type="number"
                                                    min="1"
                                                    class="ecf-input ecf-input-res"
                                                    title="Height px"
                                                />
                                            </span>
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--r">
                                            <input
                                                v-model.number="
                                                    r.videoBitrateKbps
                                                "
                                                type="number"
                                                min="1"
                                                class="ecf-input ecf-input-kbps"
                                                :disabled="r.copyStream"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <select
                                                v-model="r.audioGroupId"
                                                class="ecf-select ecf-select-inline"
                                            >
                                                <option
                                                    v-for="opt in uniqueAudioGroupOptions"
                                                    :key="opt.id"
                                                    :value="opt.id"
                                                >
                                                    {{ opt.label }}
                                                </option>
                                            </select>
                                        </td>
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="r.label"
                                                type="text"
                                                class="ecf-input ecf-input-lbl"
                                                placeholder="Main"
                                            />
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--opts">
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="r.vbr"
                                                    class="ecf-checkbox"
                                                    :disabled="r.copyStream"
                                                    @change="
                                                        r.vbr &&
                                                        (r.copyStream = false)
                                                    "
                                                />
                                                VBR
                                            </label>
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="r.copyStream"
                                                    class="ecf-checkbox"
                                                    :disabled="
                                                        editableVideoTracks.length ===
                                                        0
                                                    "
                                                    @change="onCopyToggle(r)"
                                                />
                                                Copy
                                            </label>
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--del">
                                            <button
                                                v-if="
                                                    videoRenditions.length > 1
                                                "
                                                type="button"
                                                class="ecf-btn-remove"
                                                @click="removeVideoRendition(i)"
                                                title="Remove rendition"
                                            >
                                                <svg
                                                    class="ecf-icon"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                >
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        d="M6 18L18 6M6 6l12 12"
                                                    />
                                                </svg>
                                            </button>
                                        </td>
                                    </tr>
                                </template>
                            </tbody>
                            <tfoot class="ecf-lt-foot">
                                <tr>
                                    <td
                                        :colspan="
                                            showVideoRenditionSourceColumn
                                                ? 7
                                                : 6
                                        "
                                        class="ecf-lt-add-td"
                                    >
                                        <button
                                            type="button"
                                            class="ecf-btn-add"
                                            @click="addVideoRendition"
                                        >
                                            + Add rendition
                                        </button>
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </details>

            <!-- Audio Groups (video AND audio-only mode) -->
            <details class="ecf-panel" open>
                <summary class="ecf-panel-summary">
                    <svg
                        class="ecf-panel-chevron"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        stroke-width="2"
                        aria-hidden="true"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M19 9l-7 7-7-7"
                        />
                    </svg>
                    <span class="ecf-detect-title">Audio Groups</span>
                    <span class="ecf-detect-meta"
                        >{{ audioGroups.length }} group{{
                            audioGroups.length === 1 ? '' : 's'
                        }}</span
                    >
                </summary>
                <div class="ecf-panel-body">
                    <p class="ecf-box-hint">
                        {{
                            encodingType.value === 'video'
                                ? 'Tiers referenced by video renditions'
                                : 'Audio-only HLS variants'
                        }}
                    </p>
                    <div class="ecf-table-wrap">
                        <table class="ecf-lt">
                            <thead class="ecf-lt-thead">
                                <tr>
                                    <th class="ecf-lt-th">ID</th>
                                    <th class="ecf-lt-th">Label</th>
                                    <th class="ecf-lt-th ecf-lt-th--r">kbps</th>
                                    <th class="ecf-lt-th">Channels</th>
                                    <th class="ecf-lt-th">Source track</th>
                                    <th class="ecf-lt-th">Lang</th>
                                    <th class="ecf-lt-th">Options</th>
                                    <th class="ecf-lt-th ecf-lt-th--del"></th>
                                </tr>
                            </thead>
                            <tbody>
                                <template
                                    v-for="(g, i) in audioGroups"
                                    :key="i"
                                >
                                    <tr class="ecf-lt-tr">
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="g.id"
                                                type="text"
                                                class="ecf-input ecf-input-id"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="g.label"
                                                type="text"
                                                class="ecf-input ecf-input-lbl"
                                                placeholder="HD Audio"
                                            />
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--r">
                                            <input
                                                v-model.number="
                                                    g.audioBitrateKbps
                                                "
                                                type="number"
                                                min="1"
                                                class="ecf-input ecf-input-kbps"
                                                :disabled="g.copyStream"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <select
                                                v-model.number="g.channels"
                                                class="ecf-select ecf-select-ch"
                                                :disabled="g.copyStream"
                                            >
                                                <option :value="1">Mono</option>
                                                <option :value="2">
                                                    Stereo
                                                </option>
                                                <option :value="6">5.1</option>
                                                <option :value="8">7.1</option>
                                            </select>
                                        </td>
                                        <td class="ecf-lt-td">
                                            <select
                                                v-model.number="
                                                    g.sourceTrackIndex
                                                "
                                                class="ecf-select ecf-select-src"
                                            >
                                                <option
                                                    v-for="t in editableAudioTracks"
                                                    :key="t.index"
                                                    :value="t.index"
                                                >
                                                    #{{ t.index }}:
                                                    {{ t.codec }}
                                                    {{
                                                        t.bitrateKbps
                                                            ? `${t.bitrateKbps}k`
                                                            : ''
                                                    }}
                                                    {{ channelLabel(t.channels)
                                                    }}{{
                                                        t.language
                                                            ? ` [${t.language}]`
                                                            : ''
                                                    }}
                                                </option>
                                            </select>
                                        </td>
                                        <td class="ecf-lt-td">
                                            <input
                                                v-model="g.language"
                                                type="text"
                                                class="ecf-input ecf-input-lang"
                                                placeholder="eng"
                                            />
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--opts">
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="g.vbr"
                                                    class="ecf-checkbox"
                                                    :disabled="g.copyStream"
                                                    @change="onVbrToggle(g)"
                                                />
                                                VBR
                                            </label>
                                            <label class="ecf-toggle">
                                                <input
                                                    type="checkbox"
                                                    v-model="g.copyStream"
                                                    class="ecf-checkbox"
                                                    @change="
                                                        g.copyStream &&
                                                        (g.vbr = false)
                                                    "
                                                />
                                                Copy
                                            </label>
                                        </td>
                                        <td class="ecf-lt-td ecf-lt-td--del">
                                            <button
                                                v-if="audioGroups.length > 1"
                                                type="button"
                                                class="ecf-btn-remove"
                                                @click="removeAudioGroup(i)"
                                                title="Remove audio group"
                                            >
                                                <svg
                                                    class="ecf-icon"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    stroke-width="2"
                                                >
                                                    <path
                                                        stroke-linecap="round"
                                                        stroke-linejoin="round"
                                                        d="M6 18L18 6M6 6l12 12"
                                                    />
                                                </svg>
                                            </button>
                                        </td>
                                    </tr>
                                    <tr
                                        v-if="
                                            !g.vbr &&
                                            !g.copyStream &&
                                            g.audioBitrateKbps < 100
                                        "
                                        class="ecf-lt-warning"
                                    >
                                        <td
                                            colspan="8"
                                            class="ecf-lt-warning-td"
                                        >
                                            <svg
                                                class="ecf-icon"
                                                fill="none"
                                                viewBox="0 0 24 24"
                                                stroke="currentColor"
                                                stroke-width="2"
                                                aria-hidden="true"
                                            >
                                                <path
                                                    stroke-linecap="round"
                                                    stroke-linejoin="round"
                                                    d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
                                                />
                                            </svg>
                                            CBR below 100 kbps — will be encoded
                                            as mono
                                        </td>
                                    </tr>
                                </template>
                            </tbody>
                            <tfoot class="ecf-lt-foot">
                                <tr>
                                    <td colspan="8" class="ecf-lt-add-td">
                                        <button
                                            type="button"
                                            class="ecf-btn-add"
                                            @click="addAudioGroup"
                                        >
                                            + Add group
                                        </button>
                                    </td>
                                </tr>
                            </tfoot>
                        </table>
                    </div>
                </div>
            </details>
        </div>

        <!-- ④ Action bar (hidden in session layout — header carries the CTA) -->
        <div v-if="appearance !== 'session'" class="ecf-actions">
            <button
                type="button"
                class="ecf-btn-secondary"
                @click="emit('back')"
            >
                <svg
                    class="ecf-icon"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                    aria-hidden="true"
                >
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        d="M15.75 19.5L8.25 12l7.5-7.5"
                    />
                </svg>
                Back to workflow
            </button>
            <button
                type="button"
                @click="
                    encodePrimaryAction === 'next-to-trim'
                        ? onNextToTrim()
                        : onSubmit()
                "
                :disabled="!canSubmit"
                :class="[
                    'ecf-btn-primary',
                    !canSubmit && 'ecf-btn-primary-disabled',
                ]"
            >
                {{
                    encodePrimaryAction === 'next-to-trim'
                        ? 'Next: trim segments'
                        : 'Start Encoding'
                }}
            </button>
        </div>
    </div>
</template>
