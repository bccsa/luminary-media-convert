<script setup lang="ts">
import { reactive, computed, ref } from 'vue';
import type {
    ProbeResult,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
    AudioTrackInfo,
    VideoTrackInfo,
} from './types';
import { computeLayoutKey, getStoredConfig } from './layoutStorage';

const props = defineProps<{
    probeResult: ProbeResult;
    byteRange: boolean;
}>();

const emit = defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
}>();

const showBackConfirm = ref(false);

const encodingType = reactive<{ value: 'video' | 'audio' }>({
    value: props.probeResult.videoTracks.length > 0 ? 'video' : 'audio',
});

const segmentDuration = reactive<{ value: number }>({
    value: 6,
});

const videoRenditions = reactive<VideoRendition[]>([]);

const audioGroups = reactive<AudioGroup[]>([]);

const editableVideoTracks = reactive<VideoTrackInfo[]>(
    props.probeResult.videoTracks.map(t => ({ ...t })),
);

const editableAudioTracks = reactive<AudioTrackInfo[]>(
    props.probeResult.audioTracks.map(t => ({ ...t })),
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

const AUDIO_GROUP_TIERS = [
    { minHeight: 720, groupId: 'hd', label: 'HD', bitrateKbps: 256, channels: 2 },
    { minHeight: 360, groupId: 'mid', label: 'Standard', bitrateKbps: 128, channels: 2 },
    { minHeight: 0, groupId: 'low', label: 'Bandwidth Saving', bitrateKbps: 64, channels: 2 },
];

function getAudioTierForHeight(height: number) {
    for (const tier of AUDIO_GROUP_TIERS) {
        if (height >= tier.minHeight) return tier;
    }
    return AUDIO_GROUP_TIERS[AUDIO_GROUP_TIERS.length - 1];
}

function mapTierToGroupId(standardGroupId: string, tierIds: string[]): string {
    if (tierIds.includes(standardGroupId)) return standardGroupId;
    const tierIndex = standardGroupId === 'hd' ? 0 : standardGroupId === 'mid' ? 1 : 2;
    return tierIds[Math.min(tierIndex, tierIds.length - 1)] ?? tierIds[0] ?? 'tier_0';
}

function buildSuggestedAudioGroups(audioTracks: AudioTrackInfo[], videoTrackCount: number): AudioGroup[] {
    if (audioTracks.length === 0) return [];

    const langMap = new Map<string, AudioTrackInfo[]>();
    for (const track of audioTracks) {
        const lang = track.language || 'und';
        if (!langMap.has(lang)) langMap.set(lang, []);
        langMap.get(lang)!.push(track);
    }
    for (const tracks of langMap.values()) {
        tracks.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
    }

    const languages = Array.from(langMap.keys());
    const isMultiSource = languages.length > 1
        || (languages.length === 1 && (langMap.get(languages[0])?.length ?? 0) > 1);
    const hasMultiAudioPerLang = Array.from(langMap.values()).some(tracks => tracks.length > 1);
    const isAlreadyABR = videoTrackCount > 1 && hasMultiAudioPerLang;

    const maxSourceBitrate = Math.max(...audioTracks.map(t => t.bitrateKbps || 0));
    const maxSourceChannels = Math.max(...audioTracks.map(t => t.channels || 2));
    const isMono = maxSourceChannels === 1;

    const applicableTiers = (maxSourceBitrate > 0
        ? AUDIO_GROUP_TIERS.filter(t => {
            const effective = isMono ? Math.round(t.bitrateKbps / 2) : t.bitrateKbps;
            return effective <= maxSourceBitrate + 32;
        })
        : [...AUDIO_GROUP_TIERS]
    ).map((t, i) => ({
        ...t,
        bitrateKbps: isMono ? Math.round(t.bitrateKbps / 2) : t.bitrateKbps,
        channels: i === 0 ? maxSourceChannels : Math.min(2, maxSourceChannels),
    }));
    if (applicableTiers.length === 0) {
        const fallback = AUDIO_GROUP_TIERS[AUDIO_GROUP_TIERS.length - 1];
        applicableTiers.push({
            ...fallback,
            bitrateKbps: isMono ? Math.round(fallback.bitrateKbps / 2) : fallback.bitrateKbps,
            channels: Math.min(2, maxSourceChannels),
        });
    }

    const groups: AudioGroup[] = [];

    if (isMultiSource) {
        for (let i = 0; i < applicableTiers.length; i++) {
            const tier = applicableTiers[i];
            for (const lang of languages) {
                const tracks = langMap.get(lang)!;
                const track = tracks[Math.min(i, tracks.length - 1)];
                groups.push({
                    id: tier.groupId,
                    label: languages.length > 1
                        ? (track.name ?? `${lang.toUpperCase()} ${tier.label}`)
                        : (track.name ?? tier.label),
                    audioBitrateKbps: isAlreadyABR ? (track.bitrateKbps || tier.bitrateKbps) : tier.bitrateKbps,
                    channels: isAlreadyABR ? track.channels : tier.channels,
                    audioCodec: 'aac',
                    sourceTrackIndex: track.index,
                    language: lang === 'und' ? undefined : lang,
                    copyStream: isAlreadyABR ? true : undefined,
                    vbr: !isAlreadyABR,
                });
            }
        }
    } else {
        const sourceAudio = audioTracks[0];
        for (const tier of applicableTiers) {
            groups.push({
                id: tier.groupId,
                label: tier.label,
                audioBitrateKbps: tier.bitrateKbps,
                channels: tier.channels,
                audioCodec: 'aac',
                sourceTrackIndex: sourceAudio.index,
                language: sourceAudio.language,
                vbr: true,
            });
        }
    }

    return groups;
}

function reanalyzeVideo() {
    const sortedVideoTracks = [...editableVideoTracks].sort(
        (a, b) => (b.height * b.width) - (a.height * a.width),
    );

    const newGroups = buildSuggestedAudioGroups(editableAudioTracks, sortedVideoTracks.length);
    const tierIds = [...new Set(newGroups.map(g => g.id))];
    audioGroups.splice(0, audioGroups.length, ...newGroups);

    if (sortedVideoTracks.length > 1) {
        const newRenditions: VideoRendition[] = sortedVideoTracks.map(track => {
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
        });
        videoRenditions.splice(0, videoRenditions.length, ...newRenditions);
    } else if (sortedVideoTracks.length === 1) {
        const track = sortedVideoTracks[0];
        const ladder = ABR_LADDER.filter(r => r.height <= track.height);
        if (ladder.length === 0) {
            ladder.push({
                height: track.height,
                width: track.width,
                bitrateKbps: track.bitrateKbps || 1000,
                label: `${track.height}p`,
            });
        }
        const newRenditions: VideoRendition[] = ladder.map(rung => {
            const tier = getAudioTierForHeight(rung.height);
            const audioGroupId = mapTierToGroupId(tier.groupId, tierIds);
            return {
                width: rung.width,
                height: rung.height,
                videoBitrateKbps: rung.bitrateKbps,
                copyStream: false,
                audioGroupId,
                label: rung.label,
                vbr: true,
            };
        });
        videoRenditions.splice(0, videoRenditions.length, ...newRenditions);
    }
}

function reanalyzeAudio() {
    audioGroups.splice(0, audioGroups.length, ...buildSuggestedAudioGroups(editableAudioTracks, 0));
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
    const savedConfig = getStoredConfig(computeLayoutKey(props.probeResult, encodingType.value));
    if (savedConfig) {
        if (savedConfig.videoTrackNames) {
            const nameMap = new Map(savedConfig.videoTrackNames.map(t => [t.index, t.name]));
            for (const t of editableVideoTracks) {
                const saved = nameMap.get(t.index);
                if (saved != null) t.name = saved;
            }
        }
        if (savedConfig.audioTrackMetadata) {
            const audioMetaMap = new Map(
                savedConfig.audioTrackMetadata.map(m => [m.index, { name: m.name, language: m.language }]),
            );
            for (const t of editableAudioTracks) {
                const saved = audioMetaMap.get(t.index);
                if (saved) {
                    if (saved.name !== undefined) t.name = saved.name;
                    if (saved.language !== undefined) t.language = saved.language;
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
            const groupEntries = audioGroups.filter(e => e.id === g.id);
            const langs = groupEntries
                .map(e => e.language ?? e.label ?? e.id)
                .join(', ');
            result.push({ id: g.id, label: `${g.id} (${langs})` });
        }
    }
    return result;
});

const layoutKey = computed(() =>
    computeLayoutKey(props.probeResult, encodingType.value),
);

const hasPreviousConfig = computed(() => getStoredConfig(layoutKey.value) != null);

function loadPreviousTrackLabels() {
    const config = getStoredConfig(layoutKey.value);
    if (!config) return;

    if (config.videoTrackNames) {
        const nameMap = new Map(config.videoTrackNames.map(t => [t.index, t.name]));
        for (const t of editableVideoTracks) {
            const saved = nameMap.get(t.index);
            if (saved != null) t.name = saved;
        }
    }

    if (config.audioTrackMetadata) {
        const audioMetaMap = new Map(
            config.audioTrackMetadata.map(m => [m.index, { name: m.name, language: m.language }]),
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
                rendition.videoBitrateKbps = track.bitrateKbps || rendition.videoBitrateKbps;
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
            rendition.videoBitrateKbps = track.bitrateKbps || rendition.videoBitrateKbps;
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
        fieldset.querySelectorAll<HTMLInputElement>('input[data-track-field][data-row][data-col]'),
    );
    const rows = Math.max(...inputs.map(el => parseInt(el.getAttribute('data-row') ?? '0', 10)), 0) + 1;
    const cols = Math.max(...inputs.map(el => parseInt(el.getAttribute('data-col') ?? '0', 10)), 0) + 1;

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
        el =>
            parseInt(el.getAttribute('data-row') ?? '-1', 10) === nextRow &&
            parseInt(el.getAttribute('data-col') ?? '-1', 10) === nextCol,
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
        if (videoRenditions.length === 0 || audioGroups.length === 0) return false;
        const groupIds = new Set(audioGroups.map(g => g.id));
        return videoRenditions.every(r =>
            r.width > 0 && r.height > 0 && r.videoBitrateKbps > 0 &&
            groupIds.has(r.audioGroupId) &&
            (!r.copyStream || r.sourceTrackIndex != null),
        ) && audioGroups.every(g => g.audioBitrateKbps > 0);
    }
    return audioGroups.length > 0 && audioGroups.every(g => g.audioBitrateKbps > 0);
});

function onSubmit() {
    if (!canSubmit.value) return;

    const config: EncodeConfig = {
        type: encodingType.value,
        segmentDuration: props.byteRange ? 6 : segmentDuration.value,
    };

    if (encodingType.value === 'video') {
        config.videoRenditions = videoRenditions.map(r => ({ ...r }));
        config.audioGroups = audioGroups.map(g => ({ ...g }));
        config.videoTrackNames = editableVideoTracks.map(t => ({
            index: t.index,
            name: ((t.name || `Angle ${t.index}`).trim() || `Angle ${t.index}`) as string,
        }));
        config.audioTrackMetadata = editableAudioTracks.map(t => ({
            index: t.index,
            name: t.name,
            language: t.language,
        }));
    } else {
        config.audioGroups = audioGroups.map(g => ({ ...g }));
        config.audioTrackMetadata = editableAudioTracks.map(t => ({
            index: t.index,
            name: t.name,
            language: t.language,
        }));
    }

    emit('submit', config);
}
</script>

<template>
    <div class="ecf-root">
        <!-- Probe Results -->
        <fieldset class="ecf-fieldset">
            <div class="ecf-section-header">
                <legend class="ecf-legend">Detected Media</legend>
                <button
                    v-if="hasPreviousConfig"
                    type="button"
                    @click="loadPreviousTrackLabels"
                    class="ecf-btn-accent"
                >
                    Load saved track labels
                </button>
            </div>

            <div class="ecf-info-panel">
                <div class="ecf-info-items">
                    <span>Format: <span class="ecf-info-value">{{ probeResult.format.formatName }}</span></span>
                    <span>Duration: <span class="ecf-info-value">{{ formatDuration(probeResult.format.duration) }}</span></span>
                    <span>Bitrate: <span class="ecf-info-value">{{ probeResult.format.bitrateKbps }} kbps</span></span>
                </div>
            </div>

            <!-- Video Tracks -->
            <div v-if="editableVideoTracks.length > 0">
                <h4 class="ecf-section-title">Video Tracks ({{ editableVideoTracks.length }})</h4>
                <div class="ecf-table-wrap">
                    <table class="ecf-table">
                        <thead class="ecf-thead">
                            <tr>
                                <th class="ecf-th">#</th>
                                <th class="ecf-th">Codec</th>
                                <th class="ecf-th">Resolution</th>
                                <th class="ecf-th">Bitrate</th>
                                <th class="ecf-th">FPS</th>
                                <th class="ecf-th">Name</th>
                            </tr>
                        </thead>
                        <tbody class="ecf-tbody">
                            <tr v-for="t in editableVideoTracks" :key="t.index" class="ecf-tr">
                                <td class="ecf-td">{{ t.index }}</td>
                                <td class="ecf-td">{{ t.codec }}{{ t.profile ? ` (${t.profile})` : '' }}</td>
                                <td class="ecf-td">{{ t.width }}&times;{{ t.height }}</td>
                                <td class="ecf-td">{{ t.bitrateKbps ? `${t.bitrateKbps} kbps` : '—' }}</td>
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

            <!-- Audio Tracks -->
            <div v-if="editableAudioTracks.length > 0">
                <h4 class="ecf-section-title">Audio Tracks ({{ editableAudioTracks.length }})</h4>
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
                            <tr v-for="(t, audioIdx) in editableAudioTracks" :key="t.index" class="ecf-tr">
                                <td class="ecf-td">{{ t.index }}</td>
                                <td class="ecf-td">{{ t.codec }}</td>
                                <td class="ecf-td">{{ t.bitrateKbps ? `${t.bitrateKbps} kbps` : '—' }}</td>
                                <td class="ecf-td">{{ channelLabel(t.channels) }}</td>
                                <td class="ecf-td">{{ t.sampleRate }} Hz</td>
                                <td class="ecf-td">
                                    <input
                                        v-model="t.language"
                                        type="text"
                                        class="ecf-input ecf-input-xs ecf-input-center"
                                        placeholder="und"
                                        data-track-field="audio-language"
                                        :data-track-index="t.index"
                                        :data-row="editableVideoTracks.length + audioIdx"
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
                                        :data-row="editableVideoTracks.length + audioIdx"
                                        data-col="1"
                                        @keydown="onTrackInputKeydown"
                                    />
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
            <div v-if="encodingType.value === 'video' && (editableVideoTracks.length > 0 || editableAudioTracks.length > 0)" class="ecf-reanalyze-row">
                <button
                    type="button"
                    @click="reanalyze"
                    class="ecf-btn-accent"
                >
                    Re-analyze Mapping
                </button>
            </div>
        </fieldset>

        <!-- Encoding Type + Segment Duration -->
        <fieldset class="ecf-fieldset ecf-fieldset-padded">
            <legend class="ecf-legend">Encoding</legend>
            <div class="ecf-radio-group">
                <label class="ecf-radio-label">
                    <input type="radio" v-model="encodingType.value" value="video" class="ecf-radio" :disabled="editableVideoTracks.length === 0" />
                    Video
                </label>
                <label class="ecf-radio-label">
                    <input type="radio" v-model="encodingType.value" value="audio" class="ecf-radio" />
                    Audio Only
                </label>
                <div v-if="!byteRange" class="ecf-segment-field">
                    <label class="ecf-segment-label">Segment (s)</label>
                    <input v-model.number="segmentDuration.value" type="number" min="1" class="ecf-input ecf-input-segment" />
                </div>
            </div>
        </fieldset>

        <!-- VIDEO MODE -->
        <template v-if="encodingType.value === 'video'">
            <!-- Video Renditions -->
            <fieldset class="ecf-fieldset ecf-fieldset-padded">
                <div class="ecf-section-header">
                    <legend class="ecf-legend">Video Renditions</legend>
                    <button type="button" @click="addVideoRendition" class="ecf-btn-sm">+ Add</button>
                </div>
                <div
                    v-for="(r, i) in videoRenditions"
                    :key="i"
                    class="ecf-card"
                >
                    <button
                        v-if="videoRenditions.length > 1"
                        type="button"
                        @click="removeVideoRendition(i)"
                        class="ecf-btn-remove ecf-btn-remove-corner"
                    >
                        <svg class="ecf-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                    <div class="ecf-form-row">
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Width</label>
                            <input v-model.number="r.width" type="number" min="1" class="ecf-input ecf-input-w24" :disabled="r.copyStream" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Height</label>
                            <input v-model.number="r.height" type="number" min="1" class="ecf-input ecf-input-w24" :disabled="r.copyStream" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Video kbps</label>
                            <input v-model.number="r.videoBitrateKbps" type="number" min="1" class="ecf-input ecf-input-w28" :disabled="r.copyStream" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Audio Group</label>
                            <select v-model="r.audioGroupId" class="ecf-select ecf-input-w40">
                                <option v-for="opt in uniqueAudioGroupOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
                            </select>
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Label</label>
                            <input v-model="r.label" type="text" class="ecf-input ecf-input-w24" placeholder="1080p" />
                        </div>
                    </div>
                    <div class="ecf-checkbox-row">
                        <label class="ecf-checkbox-label">
                            <input
                                type="checkbox"
                                v-model="r.vbr"
                                class="ecf-checkbox"
                                :disabled="r.copyStream"
                                @change="r.vbr && (r.copyStream = false)"
                            />
                            <span class="ecf-checkbox-text">VBR encoding</span>
                        </label>
                        <label class="ecf-checkbox-label">
                            <input
                                type="checkbox"
                                v-model="r.copyStream"
                                class="ecf-checkbox"
                                :disabled="editableVideoTracks.length === 0"
                                @change="onCopyToggle(r)"
                            />
                            <span class="ecf-checkbox-text">Copy stream (no re-encode)</span>
                        </label>
                        <template v-if="r.copyStream && editableVideoTracks.length > 0">
                            <label class="ecf-field-label">Source track:</label>
                            <select
                                v-model.number="r.sourceTrackIndex"
                                class="ecf-select ecf-input-w48"
                                @change="onCopySourceChange(r)"
                            >
                                <option v-for="t in editableVideoTracks" :key="t.index" :value="t.index">
                                    #{{ t.index }}: {{ t.width }}&times;{{ t.height }} {{ t.codec }}{{ t.name ? ` ${t.name}` : '' }} {{ t.bitrateKbps ? `${t.bitrateKbps}kbps` : '' }}
                                </option>
                            </select>
                        </template>
                    </div>
                </div>
            </fieldset>

            <!-- Audio Groups -->
            <fieldset class="ecf-fieldset ecf-fieldset-padded">
                <div class="ecf-section-header">
                    <legend class="ecf-legend">Audio Groups</legend>
                    <button type="button" @click="addAudioGroup" class="ecf-btn-sm">+ Add</button>
                </div>
                <div
                    v-for="(g, i) in audioGroups"
                    :key="i"
                    class="ecf-card"
                >
                    <button
                        v-if="audioGroups.length > 1"
                        type="button"
                        @click="removeAudioGroup(i)"
                        class="ecf-btn-remove ecf-btn-remove-corner"
                    >
                        <svg class="ecf-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                    <div class="ecf-form-row">
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Group ID</label>
                            <input v-model="g.id" type="text" class="ecf-input ecf-input-w24" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Label</label>
                            <input v-model="g.label" type="text" class="ecf-input ecf-input-w28" placeholder="HD Audio" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Audio kbps</label>
                            <input v-model.number="g.audioBitrateKbps" type="number" min="1" class="ecf-input ecf-input-w28" :disabled="g.copyStream" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Channels</label>
                            <select v-model.number="g.channels" class="ecf-select ecf-input-w24" :disabled="g.copyStream">
                                <option :value="1">Mono</option>
                                <option :value="2">Stereo</option>
                                <option :value="6">5.1</option>
                                <option :value="8">7.1</option>
                            </select>
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Source Track</label>
                            <select v-model.number="g.sourceTrackIndex" class="ecf-select ecf-input-w40">
                                <option v-for="t in editableAudioTracks" :key="t.index" :value="t.index">
                                    #{{ t.index }}: {{ t.codec }} {{ t.bitrateKbps ? `${t.bitrateKbps}kbps` : '' }} {{ channelLabel(t.channels) }}{{ t.language ? ` [${t.language}]` : '' }}
                                </option>
                            </select>
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Language</label>
                            <input v-model="g.language" type="text" class="ecf-input ecf-input-w20" placeholder="eng" />
                        </div>
                    </div>
                    <div class="ecf-checkbox-row">
                        <label class="ecf-checkbox-label">
                            <input
                                type="checkbox"
                                v-model="g.vbr"
                                class="ecf-checkbox"
                                :disabled="g.copyStream"
                                @change="onVbrToggle(g)"
                            />
                            <span class="ecf-checkbox-text">VBR encoding</span>
                        </label>
                        <label class="ecf-checkbox-label">
                            <input
                                type="checkbox"
                                v-model="g.copyStream"
                                class="ecf-checkbox"
                                @change="g.copyStream && (g.vbr = false)"
                            />
                            <span class="ecf-checkbox-text">Copy audio (no re-encode)</span>
                        </label>
                    </div>
                    <p v-if="!g.vbr && !g.copyStream && g.audioBitrateKbps < 100" class="ecf-warning">
                        CBR below 100 kbps — will be encoded as mono
                    </p>
                </div>
            </fieldset>
        </template>

        <!-- AUDIO-ONLY MODE -->
        <template v-else>
            <fieldset class="ecf-fieldset ecf-fieldset-padded">
                <div class="ecf-section-header">
                    <legend class="ecf-legend">Audio Groups</legend>
                    <button type="button" @click="addAudioGroup" class="ecf-btn-sm">+ Add</button>
                </div>
                <div
                    v-for="(g, i) in audioGroups"
                    :key="i"
                    class="ecf-card"
                >
                    <button
                        v-if="audioGroups.length > 1"
                        type="button"
                        @click="removeAudioGroup(i)"
                        class="ecf-btn-remove ecf-btn-remove-corner"
                    >
                        <svg class="ecf-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                    <div class="ecf-form-row">
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Group ID</label>
                            <input v-model="g.id" type="text" class="ecf-input ecf-input-w24" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Label</label>
                            <input v-model="g.label" type="text" class="ecf-input ecf-input-w28" placeholder="HD Audio" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Audio kbps</label>
                            <input v-model.number="g.audioBitrateKbps" type="number" min="1" class="ecf-input ecf-input-w28" :disabled="g.copyStream" />
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Channels</label>
                            <select v-model.number="g.channels" class="ecf-select ecf-input-w24" :disabled="g.copyStream">
                                <option :value="1">Mono</option>
                                <option :value="2">Stereo</option>
                                <option :value="6">5.1</option>
                                <option :value="8">7.1</option>
                            </select>
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Source Track</label>
                            <select v-model.number="g.sourceTrackIndex" class="ecf-select ecf-input-w40">
                                <option v-for="t in editableAudioTracks" :key="t.index" :value="t.index">
                                    #{{ t.index }}: {{ t.codec }} {{ t.bitrateKbps ? `${t.bitrateKbps}kbps` : '' }} {{ channelLabel(t.channels) }}{{ t.language ? ` [${t.language}]` : '' }}
                                </option>
                            </select>
                        </div>
                        <div class="ecf-form-field">
                            <label class="ecf-field-label">Language</label>
                            <input v-model="g.language" type="text" class="ecf-input ecf-input-w20" placeholder="eng" />
                        </div>
                    </div>
                    <div class="ecf-checkbox-row">
                        <label class="ecf-checkbox-label">
                            <input
                                type="checkbox"
                                v-model="g.vbr"
                                class="ecf-checkbox"
                                :disabled="g.copyStream"
                                @change="onVbrToggle(g)"
                            />
                            <span class="ecf-checkbox-text">VBR encoding</span>
                        </label>
                        <label class="ecf-checkbox-label">
                            <input
                                type="checkbox"
                                v-model="g.copyStream"
                                class="ecf-checkbox"
                                @change="g.copyStream && (g.vbr = false)"
                            />
                            <span class="ecf-checkbox-text">Copy audio (no re-encode)</span>
                        </label>
                    </div>
                    <p v-if="!g.vbr && !g.copyStream && g.audioBitrateKbps < 100" class="ecf-warning">
                        CBR below 100 kbps — will be encoded as mono
                    </p>
                </div>
            </fieldset>
        </template>

        <!-- Back confirmation banner -->
        <div
            v-if="showBackConfirm"
            class="ecf-confirm-banner"
        >
            <p class="ecf-confirm-text">
                Going back will delete the uploaded file from the server. Are you sure?
            </p>
            <div class="ecf-confirm-actions">
                <button
                    type="button"
                    @click="showBackConfirm = false"
                    class="ecf-btn-secondary"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    @click="emit('back')"
                    class="ecf-btn-danger"
                >
                    Delete &amp; Go Back
                </button>
            </div>
        </div>

        <!-- Actions -->
        <div v-else class="ecf-actions">
            <button
                type="button"
                @click="showBackConfirm = true"
                class="ecf-btn-secondary"
            >
                Back
            </button>
            <button
                type="button"
                @click="onSubmit"
                :disabled="!canSubmit"
                :class="[
                    canSubmit ? 'ecf-btn-primary' : 'ecf-btn-primary ecf-btn-primary-disabled',
                ]"
            >
                Start Encoding
            </button>
        </div>
    </div>
</template>
