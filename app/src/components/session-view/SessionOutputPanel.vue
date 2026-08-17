<script setup lang="ts">
import { ref } from 'vue';
import { EncodeConfigForm } from '@luminary-media-converter/encode-config';
import type {
    EncodeConfig,
    ProbeResult,
    TrimCopyMode,
} from '@luminary-media-converter/encode-config';

defineProps<{
    showProbeConfig: boolean;
    probeResult: ProbeResult | null;
    byteRangeEnabled: boolean;
    encodePrimaryAction?: 'start-encoding' | 'next-to-trim';
    appearance?: 'default' | 'session';
    /** Something is cut, so the ladder is judged by the quick cut's rules. */
    trimActive?: boolean;
}>();

defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
    'next-to-trim': [];
    'can-submit-change': [valid: boolean];
    'trim-mode-change': [mode: TrimCopyMode];
}>();

const encodeFormRef = ref<InstanceType<typeof EncodeConfigForm> | null>(null);

function getEncodeForm(): InstanceType<typeof EncodeConfigForm> | null {
    return encodeFormRef.value;
}

defineExpose({ encodeFormRef, getEncodeForm });
</script>

<template>
    <div class="space-y-3">
        <EncodeConfigForm
            v-if="showProbeConfig && probeResult"
            ref="encodeFormRef"
            :probe-result="probeResult"
            :byte-range="byteRangeEnabled"
            :encode-primary-action="encodePrimaryAction"
            :appearance="appearance ?? 'default'"
            :trim-active="trimActive ?? false"
            @submit="$emit('submit', $event)"
            @back="$emit('back')"
            @next-to-trim="$emit('next-to-trim')"
            @can-submit-change="$emit('can-submit-change', $event)"
            @trim-mode-change="$emit('trim-mode-change', $event)"
        />
        <p v-else class="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Output settings are only editable while the session is probed and waiting to encode. For active jobs, use the Timeline tab for progress and logs.
        </p>
    </div>
</template>
