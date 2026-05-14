<script setup lang="ts">
import type { StepVisual } from '../SessionWorkflowStepper.vue';
import { computed } from 'vue';
import ProgressBar from '../ProgressBar.vue';
import SessionWorkflowStepper from '../SessionWorkflowStepper.vue';

const props = withDefaults(
    defineProps<{
        ingest: StepVisual;
        probe: StepVisual;
        encoding: StepVisual;
        upload: StepVisual;
        finalize: StepVisual;
        showProbeConfig: boolean;
        submitting: boolean;
        showEncoding: boolean;
        isCompleted: boolean;
        currentStatus: string | null;
        showUploadProgress: boolean;
        showUploadDoneWaiting: boolean;
        showUploadRemoteMessage: boolean;
        activeUploadProgress?: number;
        activeUploadCanCancel?: boolean;
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
        pipelineEncrypting: number | null | undefined;
        pipelineUploading: number | null | undefined;
        pollerProgress: number | undefined;
        pollerError: string | null | undefined;
        /** Completed encode with encryption — show encrypt step at 100% in summary. */
        isEncrypted?: boolean;
        /** External HLS import — omit encode pipeline summary; different completion copy. */
        importedSession?: boolean;
        /** Active session tab — hides the pipeline stepper on Trim; drives post-probe copy on Workflow. */
        sessionWorkspaceTab?: 'workflow' | 'output' | 'trim' | 'post';
    }>(),
    { isEncrypted: false, importedSession: false, sessionWorkspaceTab: undefined },
);

const showLivePipeline = computed(
    () =>
        props.pollerStatus === 'encoding'
        || props.pollerStatus === 'encrypting'
        || props.pollerStatus === 'uploading_to_s3',
);

/** After a real encode job, keep pipeline steps visible at 100% (step encoding was here during the run). */
const showCompletedPipelineSummary = computed(
    () => props.isCompleted && !props.importedSession,
);

const emit = defineEmits<{
    switchTab: [tab: 'workflow' | 'output' | 'trim' | 'post'];
    cancelUpload: [];
    cancelEncode: [];
}>();
</script>

<template>
    <div class="space-y-3">
        <SessionWorkflowStepper
            v-if="sessionWorkspaceTab !== 'trim'"
            :ingest="ingest"
            :probe="probe"
            :encoding="encoding"
            :upload="upload"
            :finalize="finalize"
        />

        <template v-if="!showProbeConfig && !submitting && !(showEncoding || isCompleted || currentStatus === 'failed')">
            <div v-if="showUploadProgress && activeUploadProgress != null">
                <ProgressBar
                    :label="activeUploadProgress >= 100 ? 'Finalizing upload…' : 'Uploading…'"
                    :progress="activeUploadProgress"
                    :indeterminate="activeUploadProgress >= 100"
                />
                <div class="flex justify-end pt-2">
                    <button
                        v-if="activeUploadCanCancel"
                        type="button"
                        class="cursor-pointer rounded-lg border border-slate-300 px-4 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-100 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-700"
                        @click="emit('cancelUpload')"
                    >
                        Cancel
                    </button>
                </div>
            </div>
            <div v-else-if="showUploadDoneWaiting">
                <ProgressBar label="Analyzing…" indeterminate />
            </div>
            <div v-else-if="showUploadRemoteMessage">
                <p v-if="ingestEtaDisplay" class="mb-2 text-right text-xs text-slate-500">{{ ingestEtaDisplay }}</p>
                <ProgressBar
                    v-if="remoteIngestProgress !== undefined"
                    :label="remoteIngestLabel"
                    :progress="remoteIngestProgress"
                />
                <ProgressBar
                    v-else-if="pollerIngestTotalBytes != null"
                    :label="remoteIngestLabel"
                    indeterminate
                />
                <ProgressBar v-else label="Uploading…" indeterminate subtitle="Started elsewhere" />
            </div>
            <div v-else-if="currentStatus === 'uploaded' && probeLoading" class="flex flex-col items-center gap-3 py-10">
                <svg class="h-8 w-8 animate-spin text-slate-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p class="text-sm text-slate-500">Fetching probe results…</p>
            </div>
        </template>

        <template v-if="showProbeConfig">
            <div v-if="showUploadProgress && activeUploadProgress != null">
                <ProgressBar
                    :label="activeUploadProgress >= 100 ? 'Finalizing upload…' : 'Uploading…'"
                    :progress="activeUploadProgress"
                    :indeterminate="activeUploadProgress >= 100"
                />
            </div>
            <div
                v-else-if="
                    sessionWorkspaceTab === 'workflow'
                    && !(submitting || showEncoding || isCompleted || currentStatus === 'failed')
                "
                class="rounded-lg border border-slate-200/80 bg-slate-50/80 p-3 dark:border-slate-600 dark:bg-slate-800/40"
            >
                <p class="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                    Source is ready. Configure renditions and audio on the
                    <strong class="text-slate-800 dark:text-slate-100">Encode</strong>
                    tab, then start encoding when you are done.
                </p>
                <button
                    type="button"
                    class="mt-2 cursor-pointer rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-800 shadow-sm transition-colors hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:hover:bg-slate-800"
                    @click="emit('switchTab', 'output')"
                >
                    Open Encode →
                </button>
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

            <div v-else class="space-y-2">
                <div class="mb-0.5 flex flex-wrap items-start justify-between gap-2">
                    <div>
                        <h2 class="text-sm font-semibold text-slate-900 dark:text-slate-100">HLS package</h2>
                        <p class="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                            <template v-if="encoderLabel">{{ encoderLabel }}</template>
                            <template v-if="displaySegmentFormat"> · {{ displaySegmentFormat === 'fmp4' ? 'fMP4' : 'MPEG-TS' }}</template>
                            <template v-if="encodingType === 'audio'"> · Audio-only</template>
                        </p>
                    </div>
                    <div v-if="pollerStatus === 'queued' && pollerQueuePosition != null" class="text-xs font-medium text-amber-700 dark:text-amber-400">
                        Queue #{{ pollerQueuePosition }}
                    </div>
                </div>

                <div
                    v-if="showLivePipeline || showCompletedPipelineSummary"
                    class="space-y-2"
                >
                    <p v-if="etaDisplay && showLivePipeline" class="text-right text-xs text-slate-500">{{ etaDisplay }}</p>
                    <ProgressBar
                        label="Encoding"
                        :progress="showCompletedPipelineSummary ? 100 : (pipelineEncoding ?? pollerProgress)"
                    />
                    <ProgressBar
                        v-if="(showLivePipeline && pipelineEncrypting != null) || (showCompletedPipelineSummary && isEncrypted)"
                        label="Encrypting manifest"
                        :progress="showCompletedPipelineSummary ? 100 : (pipelineEncrypting ?? 0)"
                    />
                    <ProgressBar
                        v-if="(showLivePipeline && pipelineUploading != null) || showCompletedPipelineSummary"
                        label="S3 parallel upload"
                        :progress="showCompletedPipelineSummary ? 100 : (pipelineUploading ?? 0)"
                    />
                </div>

                <div v-if="isCompleted" class="mt-2 rounded-lg border border-emerald-200/80 bg-emerald-50/80 px-2.5 py-1.5 text-xs leading-snug text-emerald-900 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
                    <template v-if="importedSession">
                        Import ready. Delivery links and storage tools are on the
                        <button type="button" class="font-semibold underline-offset-2 hover:underline" @click="emit('switchTab', 'post')">Delivery</button>
                        tab.
                    </template>
                    <template v-else>
                        Encoding finished. Delivery links and storage tools are on the
                        <button type="button" class="font-semibold underline-offset-2 hover:underline" @click="emit('switchTab', 'post')">Delivery</button>
                        tab.
                    </template>
                </div>

                <div class="mt-2 flex flex-wrap gap-2">
                    <button
                        v-if="showEncoding && (pollerStatus === 'queued' || pollerStatus === 'encoding' || pollerStatus === 'encrypting')"
                        type="button"
                        class="cursor-pointer rounded-xl border border-red-200 bg-white px-4 py-2 text-xs font-semibold text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400 dark:hover:bg-red-950/50"
                        @click="emit('cancelEncode')"
                    >
                        Cancel encoding
                    </button>
                </div>
            </div>
        </template>

    </div>
</template>
