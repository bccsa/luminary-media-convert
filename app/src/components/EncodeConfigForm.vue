<script setup lang="ts">
import { reactive, computed, ref } from 'vue';
import type {
    ProbeResult,
    SuggestedConfig,
    EncodeConfig,
    VideoRendition,
    AudioGroup,
    AudioRendition,
    AudioTrackInfo,
} from '../types';

const props = defineProps<{
    probeResult: ProbeResult;
    suggestedConfig: SuggestedConfig;
}>();

const emit = defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
}>();

const showBackConfirm = ref(false);

const encodingType = reactive<{ value: 'video' | 'audio' }>({
    value: props.suggestedConfig.type,
});

const segmentDuration = reactive<{ value: number }>({
    value: props.suggestedConfig.segmentDuration ?? 6,
});

const videoRenditions = reactive<VideoRendition[]>(
    props.suggestedConfig.videoRenditions?.map(r => ({ ...r })) ?? [],
);

const audioGroups = reactive<AudioGroup[]>(
    props.suggestedConfig.audioGroups?.map(g => ({ ...g })) ?? [],
);

const audioRenditions = reactive<AudioRendition[]>(
    props.suggestedConfig.audioRenditions?.map(r => ({ ...r })) ?? [],
);

const editableAudioTracks = reactive<AudioTrackInfo[]>(
    props.probeResult.audioTracks.map(t => ({ ...t })),
);

function reanalyzeAudio() {
    const langMap = new Map<string, AudioTrackInfo[]>();
    for (const track of editableAudioTracks) {
        const lang = track.language || 'und';
        if (!langMap.has(lang)) langMap.set(lang, []);
        langMap.get(lang)!.push(track);
    }

    for (const tracks of langMap.values()) {
        tracks.sort((a, b) => (b.bitrateKbps || 0) - (a.bitrateKbps || 0));
    }

    const languages = Array.from(langMap.keys());
    const maxTracksPerLang = Math.max(...Array.from(langMap.values()).map(t => t.length));
    const numTiers = Math.min(videoRenditions.length, maxTracksPerLang);

    const newGroups: AudioGroup[] = [];
    for (let tier = 0; tier < numTiers; tier++) {
        const tierId = `tier_${tier}`;
        for (const lang of languages) {
            const tracks = langMap.get(lang)!;
            const track = tracks[tier] ?? tracks[tracks.length - 1];
            newGroups.push({
                id: tierId,
                label: `${lang.toUpperCase()} ${track.bitrateKbps || '?'}kbps`,
                audioBitrateKbps: track.bitrateKbps || 128,
                channels: track.channels,
                audioCodec: (track.codec === 'mp3' ? 'mp3' : 'aac') as 'aac' | 'mp3',
                sourceTrackIndex: track.index,
                language: lang === 'und' ? undefined : lang,
                copyStream: true,
            });
        }
    }

    audioGroups.splice(0, audioGroups.length, ...newGroups);

    const sortedRenditions = [...videoRenditions].sort(
        (a, b) => (b.height * b.width) - (a.height * a.width),
    );
    for (let i = 0; i < sortedRenditions.length; i++) {
        sortedRenditions[i].audioGroupId = i < numTiers ? `tier_${i}` : `tier_${numTiers - 1}`;
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

function addVideoRendition() {
    const defaultGroupId = audioGroups[0]?.id ?? 'hd';
    videoRenditions.push({
        width: 854,
        height: 480,
        videoBitrateKbps: 1000,
        copyStream: false,
        audioGroupId: defaultGroupId,
        label: '480p',
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
    });
}

function removeAudioGroup(index: number) {
    if (audioGroups.length > 1) audioGroups.splice(index, 1);
}

function addAudioRendition() {
    audioRenditions.push({
        audioBitrateKbps: 128,
        channels: 2,
        audioCodec: 'aac',
        sourceTrackIndex: 0,
        label: '128kbps',
    });
}

function removeAudioRendition(index: number) {
    if (audioRenditions.length > 1) audioRenditions.splice(index, 1);
}

function onCopyToggle(rendition: VideoRendition) {
    if (rendition.copyStream && props.probeResult.videoTracks.length > 0) {
        const track = props.probeResult.videoTracks[rendition.sourceTrackIndex ?? 0];
        if (track) {
            rendition.width = track.width;
            rendition.height = track.height;
            rendition.videoBitrateKbps = track.bitrateKbps || rendition.videoBitrateKbps;
        }
    }
}

function onCopySourceChange(rendition: VideoRendition) {
    if (rendition.copyStream && rendition.sourceTrackIndex != null) {
        const track = props.probeResult.videoTracks[rendition.sourceTrackIndex];
        if (track) {
            rendition.width = track.width;
            rendition.height = track.height;
            rendition.videoBitrateKbps = track.bitrateKbps || rendition.videoBitrateKbps;
            rendition.label = track.title ?? `${track.height}p`;
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
    return audioRenditions.length > 0 && audioRenditions.every(r => r.audioBitrateKbps > 0);
});

function onSubmit() {
    if (!canSubmit.value) return;

    const config: EncodeConfig = {
        type: encodingType.value,
        segmentDuration: segmentDuration.value,
    };

    if (encodingType.value === 'video') {
        config.videoRenditions = videoRenditions.map(r => ({ ...r }));
        config.audioGroups = audioGroups.map(g => ({ ...g }));
    } else {
        config.audioRenditions = audioRenditions.map(r => ({ ...r }));
    }

    emit('submit', config);
}
</script>

<template>
    <div class="space-y-6">
        <!-- Probe Results -->
        <fieldset class="space-y-3">
            <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Detected Media</legend>

            <div class="rounded-md bg-zinc-900/60 p-3 text-sm">
                <div class="flex flex-wrap gap-x-6 gap-y-1 text-zinc-300">
                    <span>Format: <span class="text-zinc-100">{{ probeResult.format.formatName }}</span></span>
                    <span>Duration: <span class="text-zinc-100">{{ formatDuration(probeResult.format.duration) }}</span></span>
                    <span>Bitrate: <span class="text-zinc-100">{{ probeResult.format.bitrateKbps }} kbps</span></span>
                </div>
            </div>

            <!-- Video Tracks -->
            <div v-if="probeResult.videoTracks.length > 0">
                <h4 class="mb-1 text-xs font-medium text-zinc-500">Video Tracks ({{ probeResult.videoTracks.length }})</h4>
                <div class="overflow-x-auto">
                    <table class="w-full text-xs text-left">
                        <thead class="text-zinc-500 border-b border-zinc-800">
                            <tr>
                                <th class="px-2 py-1">#</th>
                                <th class="px-2 py-1">Codec</th>
                                <th class="px-2 py-1">Resolution</th>
                                <th class="px-2 py-1">Bitrate</th>
                                <th class="px-2 py-1">FPS</th>
                                <th class="px-2 py-1">Language</th>
                                <th class="px-2 py-1">Title</th>
                            </tr>
                        </thead>
                        <tbody class="text-zinc-300">
                            <tr v-for="t in probeResult.videoTracks" :key="t.index" class="border-b border-zinc-800/50">
                                <td class="px-2 py-1">{{ t.index }}</td>
                                <td class="px-2 py-1">{{ t.codec }}{{ t.profile ? ` (${t.profile})` : '' }}</td>
                                <td class="px-2 py-1">{{ t.width }}&times;{{ t.height }}</td>
                                <td class="px-2 py-1">{{ t.bitrateKbps ? `${t.bitrateKbps} kbps` : '—' }}</td>
                                <td class="px-2 py-1">{{ t.frameRate }}</td>
                                <td class="px-2 py-1">{{ t.language ?? '—' }}</td>
                                <td class="px-2 py-1">{{ t.title ?? '—' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <!-- Audio Tracks -->
            <div v-if="editableAudioTracks.length > 0">
                <h4 class="mb-1 text-xs font-medium text-zinc-500">Audio Tracks ({{ editableAudioTracks.length }})</h4>
                <div class="overflow-x-auto">
                    <table class="w-full text-xs text-left">
                        <thead class="text-zinc-500 border-b border-zinc-800">
                            <tr>
                                <th class="px-2 py-1">#</th>
                                <th class="px-2 py-1">Codec</th>
                                <th class="px-2 py-1">Bitrate</th>
                                <th class="px-2 py-1">Channels</th>
                                <th class="px-2 py-1">Sample Rate</th>
                                <th class="px-2 py-1">Language</th>
                                <th class="px-2 py-1">Title</th>
                            </tr>
                        </thead>
                        <tbody class="text-zinc-300">
                            <tr v-for="t in editableAudioTracks" :key="t.index" class="border-b border-zinc-800/50">
                                <td class="px-2 py-1">{{ t.index }}</td>
                                <td class="px-2 py-1">{{ t.codec }}</td>
                                <td class="px-2 py-1">{{ t.bitrateKbps ? `${t.bitrateKbps} kbps` : '—' }}</td>
                                <td class="px-2 py-1">{{ channelLabel(t.channels) }}</td>
                                <td class="px-2 py-1">{{ t.sampleRate }} Hz</td>
                                <td class="px-2 py-1">
                                    <input
                                        v-model="t.language"
                                        type="text"
                                        class="input w-16 text-xs text-center"
                                        placeholder="und"
                                    />
                                </td>
                                <td class="px-2 py-1">{{ t.title ?? '—' }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <div v-if="encodingType.value === 'video'" class="mt-2">
                    <button
                        type="button"
                        @click="reanalyzeAudio"
                        class="rounded border border-indigo-700 px-3 py-1.5 text-xs font-medium text-indigo-300 transition-colors hover:bg-indigo-900/40 cursor-pointer"
                    >
                        Re-analyze Audio Mapping
                    </button>
                </div>
            </div>
        </fieldset>

        <!-- Encoding Type + Segment Duration -->
        <fieldset class="space-y-3">
            <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Encoding</legend>
            <div class="flex items-center gap-4">
                <label class="flex items-center gap-2 text-sm">
                    <input type="radio" v-model="encodingType.value" value="video" class="accent-indigo-500" :disabled="probeResult.videoTracks.length === 0" />
                    Video
                </label>
                <label class="flex items-center gap-2 text-sm">
                    <input type="radio" v-model="encodingType.value" value="audio" class="accent-indigo-500" />
                    Audio Only
                </label>
                <div class="ml-auto flex items-center gap-2">
                    <label class="text-xs text-zinc-500">Segment (s)</label>
                    <input v-model.number="segmentDuration.value" type="number" min="1" class="input w-20 text-center" />
                </div>
            </div>
        </fieldset>

        <!-- VIDEO MODE -->
        <template v-if="encodingType.value === 'video'">
            <!-- Video Renditions -->
            <fieldset class="space-y-3">
                <div class="flex items-center justify-between">
                    <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Video Renditions</legend>
                    <button type="button" @click="addVideoRendition" class="btn-sm">+ Add</button>
                </div>
                <div
                    v-for="(r, i) in videoRenditions"
                    :key="i"
                    class="rounded-md bg-zinc-900/60 p-3 space-y-2"
                >
                    <div class="flex flex-wrap items-end gap-3">
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Width</label>
                            <input v-model.number="r.width" type="number" min="1" class="input w-24" :disabled="r.copyStream" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Height</label>
                            <input v-model.number="r.height" type="number" min="1" class="input w-24" :disabled="r.copyStream" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Video kbps</label>
                            <input v-model.number="r.videoBitrateKbps" type="number" min="1" class="input w-28" :disabled="r.copyStream" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Audio Group</label>
                            <select v-model="r.audioGroupId" class="input w-40">
                                <option v-for="opt in uniqueAudioGroupOptions" :key="opt.id" :value="opt.id">{{ opt.label }}</option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Label</label>
                            <input v-model="r.label" type="text" class="input w-24" placeholder="1080p" />
                        </div>
                        <button
                            v-if="videoRenditions.length > 1"
                            type="button"
                            @click="removeVideoRendition(i)"
                            class="mb-0.5 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                        >
                            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div class="flex items-center gap-4 text-sm">
                        <label class="flex items-center gap-2">
                            <input
                                type="checkbox"
                                v-model="r.copyStream"
                                class="accent-indigo-500"
                                :disabled="probeResult.videoTracks.length === 0"
                                @change="onCopyToggle(r)"
                            />
                            <span class="text-xs text-zinc-400">Copy stream (no re-encode)</span>
                        </label>
                        <template v-if="r.copyStream && probeResult.videoTracks.length > 0">
                            <label class="text-xs text-zinc-500">Source track:</label>
                            <select
                                v-model.number="r.sourceTrackIndex"
                                class="input w-48 text-xs"
                                @change="onCopySourceChange(r)"
                            >
                                <option v-for="t in probeResult.videoTracks" :key="t.index" :value="t.index">
                                    #{{ t.index }}: {{ t.width }}&times;{{ t.height }} {{ t.codec }} {{ t.bitrateKbps ? `${t.bitrateKbps}kbps` : '' }}
                                </option>
                            </select>
                        </template>
                    </div>
                </div>
            </fieldset>

            <!-- Audio Groups -->
            <fieldset class="space-y-3">
                <div class="flex items-center justify-between">
                    <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Audio Groups</legend>
                    <button type="button" @click="addAudioGroup" class="btn-sm">+ Add</button>
                </div>
                <div
                    v-for="(g, i) in audioGroups"
                    :key="i"
                    class="rounded-md bg-zinc-900/60 p-3 space-y-2"
                >
                    <div class="flex flex-wrap items-end gap-3">
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Group ID</label>
                            <input v-model="g.id" type="text" class="input w-24" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Label</label>
                            <input v-model="g.label" type="text" class="input w-28" placeholder="HD Audio" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Audio kbps</label>
                            <input v-model.number="g.audioBitrateKbps" type="number" min="1" class="input w-28" :disabled="g.copyStream" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Channels</label>
                            <select v-model.number="g.channels" class="input w-24" :disabled="g.copyStream">
                                <option :value="1">Mono</option>
                                <option :value="2">Stereo</option>
                                <option :value="6">5.1</option>
                                <option :value="8">7.1</option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Codec</label>
                            <select v-model="g.audioCodec" class="input w-24" :disabled="g.copyStream">
                                <option value="aac">AAC</option>
                                <option value="mp3">MP3</option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Source Track</label>
                            <select v-model.number="g.sourceTrackIndex" class="input w-40 text-xs">
                                <option v-for="t in editableAudioTracks" :key="t.index" :value="t.index">
                                    #{{ t.index }}: {{ t.codec }} {{ t.bitrateKbps ? `${t.bitrateKbps}kbps` : '' }} {{ channelLabel(t.channels) }}{{ t.language ? ` [${t.language}]` : '' }}
                                </option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Language</label>
                            <input v-model="g.language" type="text" class="input w-20" placeholder="eng" />
                        </div>
                        <button
                            v-if="audioGroups.length > 1"
                            type="button"
                            @click="removeAudioGroup(i)"
                            class="mb-0.5 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                        >
                            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div class="flex items-center gap-4 text-sm">
                        <label class="flex items-center gap-2">
                            <input type="checkbox" v-model="g.copyStream" class="accent-indigo-500" />
                            <span class="text-xs text-zinc-400">Copy audio (no re-encode)</span>
                        </label>
                    </div>
                </div>
            </fieldset>
        </template>

        <!-- AUDIO-ONLY MODE -->
        <template v-else>
            <fieldset class="space-y-3">
                <div class="flex items-center justify-between">
                    <legend class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Audio Renditions</legend>
                    <button type="button" @click="addAudioRendition" class="btn-sm">+ Add</button>
                </div>
                <div
                    v-for="(r, i) in audioRenditions"
                    :key="i"
                    class="rounded-md bg-zinc-900/60 p-3 space-y-2"
                >
                    <div class="flex flex-wrap items-end gap-3">
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Audio kbps</label>
                            <input v-model.number="r.audioBitrateKbps" type="number" min="1" class="input w-28" :disabled="r.copyStream" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Channels</label>
                            <select v-model.number="r.channels" class="input w-24" :disabled="r.copyStream">
                                <option :value="1">Mono</option>
                                <option :value="2">Stereo</option>
                                <option :value="6">5.1</option>
                                <option :value="8">7.1</option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Codec</label>
                            <select v-model="r.audioCodec" class="input w-24" :disabled="r.copyStream">
                                <option value="aac">AAC</option>
                                <option value="mp3">MP3</option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Source Track</label>
                            <select v-model.number="r.sourceTrackIndex" class="input w-40 text-xs">
                                <option v-for="t in editableAudioTracks" :key="t.index" :value="t.index">
                                    #{{ t.index }}: {{ t.codec }} {{ t.bitrateKbps ? `${t.bitrateKbps}kbps` : '' }} {{ channelLabel(t.channels) }}{{ t.language ? ` [${t.language}]` : '' }}
                                </option>
                            </select>
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Language</label>
                            <input v-model="r.language" type="text" class="input w-20" placeholder="eng" />
                        </div>
                        <div>
                            <label class="mb-1 block text-xs text-zinc-500">Label</label>
                            <input v-model="r.label" type="text" class="input w-24" placeholder="128kbps" />
                        </div>
                        <button
                            v-if="audioRenditions.length > 1"
                            type="button"
                            @click="removeAudioRendition(i)"
                            class="mb-0.5 rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                        >
                            <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                        </button>
                    </div>
                    <div class="flex items-center gap-4 text-sm">
                        <label class="flex items-center gap-2">
                            <input type="checkbox" v-model="r.copyStream" class="accent-indigo-500" />
                            <span class="text-xs text-zinc-400">Copy audio (no re-encode)</span>
                        </label>
                    </div>
                </div>
            </fieldset>
        </template>

        <!-- Back confirmation banner -->
        <div
            v-if="showBackConfirm"
            class="rounded-lg border border-amber-800/50 bg-amber-950/40 p-4"
        >
            <p class="mb-3 text-sm text-amber-300">
                Going back will delete the uploaded file from the server. Are you sure?
            </p>
            <div class="flex gap-3">
                <button
                    type="button"
                    @click="showBackConfirm = false"
                    class="rounded-lg border border-zinc-700 px-4 py-2 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    @click="emit('back')"
                    class="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-red-500 cursor-pointer"
                >
                    Delete &amp; Go Back
                </button>
            </div>
        </div>

        <!-- Actions -->
        <div v-else class="flex gap-3">
            <button
                type="button"
                @click="showBackConfirm = true"
                class="rounded-lg border border-zinc-700 px-6 py-3 text-sm font-semibold text-zinc-300 transition-colors hover:bg-zinc-800 cursor-pointer"
            >
                Back
            </button>
            <button
                type="button"
                @click="onSubmit"
                :disabled="!canSubmit"
                :class="[
                    'flex-1 rounded-lg px-6 py-3 text-sm font-semibold transition-colors',
                    canSubmit
                        ? 'bg-indigo-600 text-white hover:bg-indigo-500 cursor-pointer'
                        : 'bg-zinc-800 text-zinc-500 cursor-not-allowed',
                ]"
            >
                Start Encoding
            </button>
        </div>
    </div>
</template>
