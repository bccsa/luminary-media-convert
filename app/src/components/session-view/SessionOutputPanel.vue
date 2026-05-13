<script setup lang="ts">
import { ref } from 'vue';
import { EncodeConfigForm } from '@luminary-media-converter/encode-config';
import type { EncodeConfig, ProbeResult } from '@luminary-media-converter/encode-config';

defineProps<{
    showProbeConfig: boolean;
    probeResult: ProbeResult | null;
    byteRangeEnabled: boolean;
    encodePrimaryAction?: 'start-encoding' | 'next-to-trim';
    appearance?: 'default' | 'session';
}>();

defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
    'next-to-trim': [];
    'can-submit-change': [valid: boolean];
}>();

const encodeFormRef = ref<InstanceType<typeof EncodeConfigForm> | null>(null);

function getEncodeForm(): InstanceType<typeof EncodeConfigForm> | null {
    return encodeFormRef.value;
}

defineExpose({ encodeFormRef, getEncodeForm });
</script>

<template>
    <div class="space-y-5">
        <EncodeConfigForm
            v-if="showProbeConfig && probeResult"
            ref="encodeFormRef"
            :probe-result="probeResult"
            :byte-range="byteRangeEnabled"
            :encode-primary-action="encodePrimaryAction"
            :appearance="appearance ?? 'default'"
            @submit="$emit('submit', $event)"
            @back="$emit('back')"
            @next-to-trim="$emit('next-to-trim')"
            @can-submit-change="$emit('can-submit-change', $event)"
        />
        <p v-else class="text-sm leading-relaxed text-slate-500 dark:text-slate-400">
            Output settings are only editable while the session is probed and waiting to encode. For active jobs, use the Encode workflow tab for progress and logs.
        </p>
    </div>
</template>
