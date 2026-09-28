<script setup lang="ts">
import { reactive, computed, ref, watch } from 'vue';
import type {
    ProbeResult,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
    AudioTrackInfo,
    VideoTrackInfo,
    TrimCopyMode,
} from './types';
import { computeLayoutKey, getStoredConfig } from './layoutStorage';
import {
    aspectWidthForHeight,
    fpsAdjustedBitrateKbps,
    ladderFor,
    nextRenditionRung,
} from './ladder';
import { displayDimensionsOf } from './aspect';
import {
    buildSuggestedAudioGroups,
    getAudioTierForHeight,
} from './audioGroups';
import { applySavedTrackLabels } from './trackLabels';
import LanguageSelect from './LanguageSelect.vue';
import SelectMenu, { type SelectMenuOption } from './SelectMenu.vue';
import {
    copyModeBlockedReason,
    latestStreamStart,
    quickTrimBlockedReason,
} from './copyMode';

const props = withDefaults(
    defineProps<{
        probeResult: ProbeResult;
        byteRange: boolean;
        /** When `next-to-trim`, primary CTA navigates to trim instead of submitting encode. */
        encodePrimaryAction?: 'start-encoding' | 'next-to-trim';
        /** `session` — light slate panels for embedding in the web app session card. */
        appearance?: 'default' | 'session';
        /**
         * Something has been cut, so a submitted encode would take the quick
         * (smart cut) path rather than a straight copy. The API gates that path
         * on cadence alone — no alignment rule — so the Copy tick boxes relax
         * with it, or a mutually offset multi-stream source could never reach
         * the very path built for it.
         */
        trimActive?: boolean;
    }>(),
    {
        encodePrimaryAction: 'start-encoding',
        appearance: 'default',
        trimActive: false,
    }
);

const emit = defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
    'next-to-trim': [];
    'can-submit-change': [valid: boolean];
    /**
     * How a trim submitted with this ladder would be cut. Derived from the copy
     * checkboxes — the form has no trim-mode control, because the copy ticks
     * already are one — so the host can say which of the two paths the Start
     * button is about to take.
     */
    'trim-mode-change': [mode: TrimCopyMode];
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

/**
 * The segment length the encode will actually use — byte-range output pins it
 * at 6 s. Copy eligibility turns on this number, so it has to be the same one
 * `buildEncodeConfig` submits.
 */
const effectiveSegmentDuration = computed(() =>
    props.byteRange ? 6 : segmentDuration.value
);

/** Where the encoder will seek to, 0 when the source needs no aligning. */
const alignmentStart = computed(() => latestStreamStart(props.probeResult));

/**
 * Why this rendition cannot be copied, or null when it can.
 *
 * A courtesy so nobody ticks a box the API refuses — see `copyMode.ts`. It is
 * asked of the track the rendition is currently pointed at, so changing the
 * source picker changes the answer, and it follows whichever of the API's two
 * gates the submit would meet: the quick cut's cadence-only rule while
 * something is trimmed, the full rule otherwise.
 */
function copyBlockedReason(rendition: VideoRendition): string | null {
    const track = editableVideoTracks[rendition.sourceTrackIndex ?? 0];
    if (!track) return null;
    return props.trimActive
        ? quickTrimBlockedReason(track, effectiveSegmentDuration.value)
        : copyModeBlockedReason(
              track,
              alignmentStart.value,
              effectiveSegmentDuration.value
          );
}

/**
 * Un-tick any Copy the tightening rule no longer allows.
 *
 * Clearing the last cut takes the quick path away with it, and a rendition left
 * copying under the relaxed rule would sit greyed out and still ticked, with no
 * way back — the same dead end `onCopySourceChange` avoids when a copy
 * rendition is pointed at a track that does not qualify, handled the same way.
 */
watch(
    () => props.trimActive,
    (active, wasActive) => {
        if (active || !wasActive) return;
        for (const rendition of videoRenditions) {
            if (rendition.copyStream && copyBlockedReason(rendition) != null) {
                rendition.copyStream = false;
                continue;
            }
            if (rendition.copyStream && rendition.sourceTrackIndex != null) {
                const track = editableVideoTracks[rendition.sourceTrackIndex];
                if (track) {
                    // Coded dimensions, and correctly so: a copy publishes the
                    // source's own bytes. It is only reached for a track whose
                    // coded and display sizes agree, because an anamorphic one
                    // was un-ticked by the guard above.
                    rendition.width = track.width;
                    rendition.height = track.height;
                    rendition.videoBitrateKbps =
                        track.bitrateKbps || rendition.videoBitrateKbps;
                }
            }
        }
    }
);

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

// By display area, not coded area: two angles of the same picture size should
// sort together whatever shape their samples are.
function displayArea(t: VideoTrackInfo): number {
    const d = displayDimensionsOf(t);
    return d.width * d.height;
}

function videoTracksByDisplayArea(): VideoTrackInfo[] {
    return [...editableVideoTracks].sort(
        (a, b) => displayArea(b) - displayArea(a)
    );
}

/** The angle a hand-added rendition is sized against. */
function tallestVideoTrack(): VideoTrackInfo | undefined {
    return videoTracksByDisplayArea()[0];
}

function reanalyzeVideo() {
    const sortedVideoTracks = videoTracksByDisplayArea();

    const newGroups = buildSuggestedAudioGroups(
        editableAudioTracks,
        sortedVideoTracks.length
    );
    const tierIds = [...new Set(newGroups.map((g) => g.id))];
    audioGroups.splice(0, audioGroups.length, ...newGroups);

    if (sortedVideoTracks.length > 1) {
        const newRenditions: VideoRendition[] = sortedVideoTracks.map(
            (track) => {
                const display = displayDimensionsOf(track);
                const tier = getAudioTierForHeight(display.height);
                const audioGroupId = mapTierToGroupId(tier.groupId, tierIds);
                // Multi-angle output has always defaulted to copying each
                // angle — it is far and away the cheapest thing to do with a
                // second camera. It is only offered where the source qualifies
                // for it, though, or the form would open on a configuration the
                // API refuses and the tick box would be greyed out and ticked.
                const canCopy =
                    copyModeBlockedReason(
                        track,
                        alignmentStart.value,
                        effectiveSegmentDuration.value
                    ) == null;
                return {
                    // Display dimensions: the encoder scales to these and tags
                    // the result square. An anamorphic angle is never `canCopy`
                    // — `copyModeBlockedReason` refuses it — so a copied angle's
                    // display size and coded size are the same number anyway.
                    width: display.width,
                    height: display.height,
                    videoBitrateKbps: track.bitrateKbps || 1000,
                    copyStream: canCopy,
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
        const display = displayDimensionsOf(track);
        const newRenditions: VideoRendition[] = ladderFor(track).map((rung) => {
            const tier = getAudioTierForHeight(rung.height);
            const audioGroupId = mapTierToGroupId(tier.groupId, tierIds);
            return {
                width: aspectWidthForHeight(
                    rung.height,
                    display.width,
                    display.height
                ),
                height: rung.height,
                videoBitrateKbps: fpsAdjustedBitrateKbps(
                    rung.bitrateKbps,
                    track.frameRate ?? 30
                ),
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
        // Fill blanks only — never overwrite what the source itself provided.
        applySavedTrackLabels(
            savedConfig,
            editableVideoTracks,
            editableAudioTracks,
            false
        );
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

    // Asked for explicitly, so the saved set replaces what is on screen.
    applySavedTrackLabels(
        config,
        editableVideoTracks,
        editableAudioTracks,
        true
    );
}

function addVideoRendition() {
    const track = tallestVideoTrack();
    const display = displayDimensionsOf(track);
    const rung = nextRenditionRung(
        track,
        videoRenditions.map((r) => r.height)
    );
    videoRenditions.push({
        width: aspectWidthForHeight(rung.height, display.width, display.height),
        height: rung.height,
        videoBitrateKbps: fpsAdjustedBitrateKbps(
            rung.bitrateKbps,
            track?.frameRate ?? 30
        ),
        copyStream: false,
        audioGroupId: audioGroups[0]?.id ?? 'hd',
        // Left unset, like every suggested rung: the name falls back to the
        // height, which is what keeps the stream directories apart.
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
    // Pointing a copy rendition at a track that does not qualify would leave
    // the tick box greyed out and still ticked, with no way back. Drop to
    // re-encode instead; the reason is on the tooltip.
    if (rendition.copyStream && copyBlockedReason(rendition) != null) {
        rendition.copyStream = false;
    }
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
    if (e.defaultPrevented) return;
    const target = e.target as HTMLElement;
    if (!target?.hasAttribute?.('data-track-field')) return;
    const row = parseInt(target.getAttribute('data-row') ?? '-1', 10);
    const col = parseInt(target.getAttribute('data-col') ?? '-1', 10);
    if (row < 0 || col < 0) return;

    const fieldset = target.closest('fieldset');
    if (!fieldset) return;
    const inputs = Array.from(
        fieldset.querySelectorAll<HTMLElement>(
            '[data-track-field][data-row][data-col]'
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
        if (next instanceof HTMLInputElement) next.select();
    }
}

function channelLabel(ch: number): string {
    if (ch === 1) return 'Mono';
    if (ch === 2) return 'Stereo';
    if (ch === 6) return '5.1';
    if (ch === 8) return '7.1';
    return `${ch}ch`;
}

const CHANNEL_OPTIONS: readonly SelectMenuOption[] = [1, 2, 6, 8].map((ch) => ({
    value: ch,
    label: channelLabel(ch),
}));

const videoSourceOptions = computed<SelectMenuOption[]>(() =>
    editableVideoTracks.map((t) => ({
        value: t.index,
        label:
            `#${t.index}${t.name ? ` — ${t.name}` : ''} ` +
            `(${t.width}×${t.height}, ${
                t.bitrateKbps != null && t.bitrateKbps > 0
                    ? `${t.bitrateKbps} kbps`
                    : 'bitrate n/a'
            })`,
    }))
);

const audioSourceOptions = computed<SelectMenuOption[]>(() =>
    editableAudioTracks.map((t) => ({
        value: t.index,
        label: [
            `#${t.index}:`,
            t.codec,
            t.bitrateKbps ? `${t.bitrateKbps}k` : '',
            `${channelLabel(t.channels)}${t.language ? ` [${t.language}]` : ''}`,
        ]
            .filter(Boolean)
            .join(' '),
    }))
);

const audioGroupSelectOptions = computed<SelectMenuOption[]>(() =>
    uniqueAudioGroupOptions.value.map((o) => ({ value: o.id, label: o.label }))
);

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

/**
 * Which streams this ladder copies, in the same terms the API infers a trim
 * mode from — video renditions count only for a video encode, exactly as
 * `quickTrimStreamTargets` counts them, or the label would promise a quick cut
 * the encoder refuses.
 */
const trimCopyMode = computed<TrimCopyMode>(() => {
    const flags: boolean[] = [];
    if (encodingType.value === 'video') {
        for (const rendition of videoRenditions)
            flags.push(rendition.copyStream === true);
    }
    for (const group of audioGroups) flags.push(group.copyStream === true);

    if (flags.length === 0) return 'precise';
    if (flags.every((copied) => copied)) return 'quick';
    if (flags.every((copied) => !copied)) return 'precise';
    return 'mixed';
});

watch(
    trimCopyMode,
    (mode) => {
        emit('trim-mode-change', mode);
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
                                        <LanguageSelect
                                            v-model="t.language"
                                            placeholder="und"
                                            aria-label="Track language"
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
                                            <SelectMenu
                                                v-model="r.sourceTrackIndex"
                                                :options="videoSourceOptions"
                                                class="ecf-select-src"
                                                aria-label="Source track"
                                                @change="onCopySourceChange(r)"
                                            />
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
                                            <SelectMenu
                                                v-model="r.audioGroupId"
                                                :options="
                                                    audioGroupSelectOptions
                                                "
                                                class="ecf-select-inline"
                                                aria-label="Audio group"
                                            />
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
                                            <label
                                                class="ecf-toggle"
                                                :title="
                                                    copyBlockedReason(r) ??
                                                    undefined
                                                "
                                            >
                                                <input
                                                    type="checkbox"
                                                    v-model="r.copyStream"
                                                    class="ecf-checkbox"
                                                    :disabled="
                                                        editableVideoTracks.length ===
                                                            0 ||
                                                        copyBlockedReason(r) !=
                                                            null
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
                                            <SelectMenu
                                                v-model="g.channels"
                                                :options="CHANNEL_OPTIONS"
                                                class="ecf-select-ch"
                                                aria-label="Channels"
                                                :disabled="g.copyStream"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <SelectMenu
                                                v-model="g.sourceTrackIndex"
                                                :options="audioSourceOptions"
                                                class="ecf-select-src"
                                                aria-label="Source track"
                                            />
                                        </td>
                                        <td class="ecf-lt-td">
                                            <LanguageSelect
                                                v-model="g.language"
                                                placeholder="eng"
                                                aria-label="Audio group language"
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
