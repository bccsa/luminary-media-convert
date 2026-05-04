<script setup lang="ts">
import { computed } from 'vue';
import ConfirmDangerModal from './ConfirmDangerModal.vue';

const props = withDefaults(
    defineProps<{
        open: boolean;
        sessionLabel: string;
        hasS3Files: boolean;
        loading?: boolean;
    }>(),
    { loading: false },
);

const emit = defineEmits<{
    'update:open': [value: boolean];
    confirm: [withFiles: boolean];
}>();

const s3Option = computed(() =>
    props.hasS3Files
        ? {
              label: 'Also delete output files from S3 (objects under this session’s prefix).',
          }
        : undefined,
);

function onConfirm(withFiles: boolean) {
    emit('confirm', withFiles);
}
</script>

<template>
    <ConfirmDangerModal
        :open="open"
        title="Delete session"
        :danger-option="s3Option"
        confirm-label="Delete session"
        loading-label="Deleting…"
        :loading="loading"
        @update:open="emit('update:open', $event)"
        @confirm="onConfirm"
    >
        <p>
            Remove
            <span class="font-medium text-zinc-900 dark:text-zinc-200">{{
                sessionLabel?.trim() || 'this session'
            }}</span>
            from your account. This cannot be undone.
        </p>
    </ConfirmDangerModal>
</template>
