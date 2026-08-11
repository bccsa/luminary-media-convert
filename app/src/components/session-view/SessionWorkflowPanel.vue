<script setup lang="ts">
import { computed } from 'vue';
import ProgressBar from '../ProgressBar.vue';
import type { PipelinePhase } from '../../types';

const props = withDefaults(
    defineProps<{
        showProbeConfig: boolean;
        submitting: boolean;
        showEncoding: boolean;
        isCompleted: boolean;
        currentStatus: string | null;
        /** The encoder is reading the source it was pointed at. */
        showUploadRemoteMessage: boolean;
        remoteIngestProgress?: number;
        remoteIngestLabel: string;
        ingestEtaDisplay?: string;
        pollerIngestTotalBytes: number | null | undefined;
        probeLoading: boolean;
        sessionError?: string;
        encoderLabel?: string;
        displaySegmentFormat?: string;
        encodingType: 'video' | 'audio';
        etaDisplay?: string;
        pollerStatus: string | null | undefined;
        pollerQueuePosition: number | null | undefined;
        pipelineEncoding: number | null | undefined;
        pipelinePhase: PipelinePhase | null | undefined;
        pipelineEncrypting: number | null | undefined;
        pipelineUploading: number | null | undefined;
        pollerProgress: number | undefined;
        pollerError: string | null | undefined;
        /** Completed encode with encryption — show encrypt step at 100% in summary. */
        isEncrypted?: boolean;
    }>(),
    { isEncrypted: false },
);

const showLivePipeline = computed(
    () =>
        props.pollerStatus === 'encoding'
        || props.pollerStatus === 'encrypting'
        || props.pollerStatus === 'uploading_to_s3',
);

/**
 * What the post-drain steps are called on screen.
 *
 * `encoding` is deliberately absent: while the segment pipeline is running the
 * bar already says so, and captioning it would be noise. These names describe
 * the work rather than the function that does it — "Generating thumbnails"
 * rather than "thumbnailService", because the person reading it is waiting, not
 * debugging.
 */
const PHASE_LABELS: Record<PipelinePhase, string | null> = {
    encoding: null,
    draining: 'Packing segments…',
    'finalising-playlists': 'Finalising playlists…',
    thumbnails: 'Generating thumbnails…',
    waveform: 'Generating waveform…',
    'encrypting-playlists': 'Encrypting playlists…',
    'uploading-playlists': 'Uploading playlists & thumbnails…',
};

const phaseLabel = computed(() =>
    props.pipelinePhase ? PHASE_LABELS[props.pipelinePhase] : null,
);

/** After a real encode job, keep pipeline steps visible at 100% (step encoding was here during the run). */
const showCompletedPipelineSummary = computed(() => props.isCompleted);

const emit = defineEmits<{
    switchTab: [tab: 'output' | 'trim' | 'post'];
    cancelEncode: [];
}>();
</script>

<template>
    <div class="space-y-3">
        <template v-if="!showProbeConfig && !submitting && !(showEncoding || isCompleted || currentStatus === 'failed')">
            <div
                v-if="showUploadRemoteMessage"
                class="flex flex-col items-center gap-5 px-2 py-4 text-center"
            >
                <div class="flex h-14 w-14 items-center justify-center rounded-full bg-sky-100 text-sky-600 ring-[6px] ring-sky-50/80 dark:bg-sky-500/20 dark:text-sky-300 dark:ring-sky-500/10">
                    <svg class="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/>
                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>
                    </svg>
                </div>
                <div class="space-y-1">
                    <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">Reading your file</h2>
                    <p class="text-xs leading-relaxed text-slate-500 dark:text-slate-400">
                        The encoder is inspecting the source where it lies — encoding options will appear once it finishes.
                    </p>
                </div>
                <ProgressBar
                    v-if="remoteIngestProgress !== undefined"
                    class="w-full max-w-md"
                    :label="remoteIngestLabel"
                    :progress="remoteIngestProgress"
                />
                <ProgressBar
                    v-else-if="pollerIngestTotalBytes != null"
                    class="w-full max-w-md"
                    :label="remoteIngestLabel"
                    indeterminate
                />
                <ProgressBar v-else class="w-full max-w-md" label="Reading source…" indeterminate />
                <p v-if="ingestEtaDisplay" class="text-[11px] text-slate-500 dark:text-slate-400">{{ ingestEtaDisplay }}</p>
            </div>
            <div v-else-if="currentStatus === 'uploaded' && probeLoading" class="flex flex-col items-center gap-3 py-10">
                <svg class="h-8 w-8 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p class="text-sm text-slate-500">Fetching probe results…</p>
            </div>
        </template>

        <div v-if="submitting" class="flex flex-col items-center gap-3 py-12">
            <svg class="h-8 w-8 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            <p class="text-sm text-slate-500">Starting encoding…</p>
        </div>

        <template v-if="(showEncoding || isCompleted || currentStatus === 'failed') && !submitting">
            <div
                v-if="currentStatus === 'failed'"
                class="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800/50 dark:bg-red-950/40"
            >
                <p class="text-sm font-medium text-red-900 dark:text-red-400">Encoding failed</p>
                <p v-if="pollerError || sessionError" class="mt-1 text-sm text-red-700 dark:text-red-300">
                    {{ pollerError || sessionError }}
                </p>
            </div>

            <div v-else class="space-y-3">
                <!-- Header row -->
                <div class="flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">HLS package</h2>
                        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            <template v-if="encoderLabel">{{ encoderLabel }}</template>
                            <template v-if="displaySegmentFormat"> · {{ displaySegmentFormat === 'fmp4' ? 'fMP4' : 'MPEG-TS' }}</template>
                            <template v-if="encodingType === 'audio'"> · Audio-only</template>
                        </p>
                    </div>
                    <div v-if="pollerStatus === 'queued' && pollerQueuePosition != null" class="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-400">
                        Queue position #{{ pollerQueuePosition }}
                    </div>
                    <p v-if="etaDisplay && showLivePipeline" class="text-xs text-slate-500 dark:text-slate-400">{{ etaDisplay }}</p>
                </div>

                <!-- Pipeline steps -->
                <div
                    v-if="showLivePipeline || showCompletedPipelineSummary"
                    class="rounded-lg border border-slate-200/80 bg-slate-50/60 px-3 py-3 space-y-3 dark:border-slate-700/50 dark:bg-slate-800/30"
                >
                    <ProgressBar
                        label="Encoding"
                        :progress="showCompletedPipelineSummary ? 100 : (pipelineEncoding ?? pollerProgress)"
                    />
                    <!--
                        What is happening after the bar reaches 100%. Draining
                        is not finishing: sprites, the waveform sidecar and
                        text-asset encryption still run, and on a long source
                        the sprites alone take minutes. Without this the screen
                        showed a full bar over work still in progress, which
                        reads as stalled rather than busy.
                    -->
                    <p
                        v-if="showLivePipeline && phaseLabel"
                        data-testid="pipeline-phase"
                        class="-mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400"
                    >
                        <span
                            class="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-500"
                            aria-hidden="true"
                        />
                        {{ phaseLabel }}
                    </p>
                    <ProgressBar
                        v-if="(showLivePipeline && pipelineEncrypting != null) || (showCompletedPipelineSummary && isEncrypted)"
                        label="Encrypting"
                        :progress="showCompletedPipelineSummary ? 100 : (pipelineEncrypting ?? 0)"
                    />
                    <ProgressBar
                        v-if="(showLivePipeline && pipelineUploading != null) || showCompletedPipelineSummary"
                        label="S3 upload"
                        :progress="showCompletedPipelineSummary ? 100 : (pipelineUploading ?? 0)"
                    />
                </div>

                <!-- Completed -->
                <div v-if="isCompleted" class="rounded-lg border border-emerald-200/80 bg-emerald-50/80 px-3 py-2.5 text-xs leading-snug text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
                    Encoding finished. Delivery links are on the
                    <button type="button" class="font-semibold underline-offset-2 hover:underline" @click="emit('switchTab', 'post')">Delivery</button> tab.
                </div>

                <!--
                    Cancel. Not in `encrypting`: the API refuses to delete a
                    session whose pipeline is mid-write, so the button there
                    could only ever fail — and the failure used to be swallowed,
                    leaving the user believing they had cancelled something that
                    carried on encrypting and uploading.
                -->
                <div v-if="showEncoding && (pollerStatus === 'queued' || pollerStatus === 'encoding')">
                    <button
                        type="button"
                        class="cursor-pointer rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40"
                        @click="emit('cancelEncode')"
                    >
                        Cancel encoding
                    </button>
                </div>
            </div>
        </template>

    </div>
</template>
