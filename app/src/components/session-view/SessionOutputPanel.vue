<script setup lang="ts">
import { ref } from 'vue';
import { EncodeConfigForm } from '@luminary-media-converter/encode-config';
import type { EncodeConfig, ProbeResult } from '@luminary-media-converter/encode-config';

defineProps<{
    showProbeConfig: boolean;
    probeResult: ProbeResult | null;
    byteRangeEnabled: boolean;
}>();

defineEmits<{
    submit: [config: EncodeConfig];
    back: [];
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
            @submit="$emit('submit', $event)"
            @back="$emit('back')"
        />
        <p v-else class="text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
            Output settings are only editable while the session is probed and waiting to encode. For active jobs, use the Encode workflow tab for progress and logs.
        </p>
    </div>
</template>
