<script setup lang="ts">
import ConfirmDangerModal from './ConfirmDangerModal.vue';

withDefaults(
    defineProps<{
        open: boolean;
        sessionLabel: string;
        loading?: boolean;
    }>(),
    { loading: false },
);

const emit = defineEmits<{
    'update:open': [value: boolean];
    confirm: [];
}>();
</script>

<template>
    <ConfirmDangerModal
        :open="open"
        title="Dismiss session"
        confirm-label="Dismiss session"
        loading-label="Dismissing…"
        :loading="loading"
        @update:open="emit('update:open', $event)"
        @confirm="emit('confirm')"
    >
        <p>
            Remove
            <span class="font-medium text-slate-900 dark:text-slate-200">{{
                sessionLabel?.trim() || 'this session'
            }}</span>
            from the encoder and free its working files. The encoded output
            stays in your bucket. This cannot be undone.
        </p>
    </ConfirmDangerModal>
</template>
