<script setup lang="ts">
import { useRegisterSW } from 'virtual:pwa-register/vue';

// 1 hour
const SW_UPDATE_INTERVAL_MS = 60 * 60 * 1000;

const { needRefresh, updateServiceWorker } = useRegisterSW({
    onRegistered(registration) {
        if (!registration) return;
        setInterval(() => {
            registration.update();
        }, SW_UPDATE_INTERVAL_MS);
    },
});

function dismiss() {
    needRefresh.value = false;
}

async function reload() {
    await updateServiceWorker(true);
}
</script>

<template>
    <div
        v-if="needRefresh"
        class="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-3 rounded-xl border border-sky-200/80 bg-white p-4 shadow-lg dark:border-sky-500/25 dark:bg-slate-900"
        role="alert"
        aria-live="polite"
    >
        <p class="text-sm text-slate-700 dark:text-slate-200">
            A new version is available. Reload to get the latest changes.
        </p>
        <div class="flex justify-end gap-2">
            <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                @click="dismiss"
            >
                Dismiss
            </button>
            <button
                type="button"
                class="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 dark:bg-sky-500 dark:hover:bg-sky-600"
                @click="reload"
            >
                Reload
            </button>
        </div>
    </div>
</template>
