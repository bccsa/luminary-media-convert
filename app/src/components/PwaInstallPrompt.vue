<script setup lang="ts">
import { usePwaInstall } from '../composables/usePwaInstall';

const { visible, iosHint, installing, canInstall, dismiss, install } = usePwaInstall();
</script>

<template>
    <div
        v-if="visible"
        class="fixed bottom-4 left-4 z-50 flex max-w-sm flex-col gap-3 rounded-xl border border-sky-200/80 bg-white p-4 shadow-lg dark:border-sky-500/25 dark:bg-slate-900 sm:max-w-md"
        role="dialog"
        aria-labelledby="pwa-install-title"
        aria-live="polite"
    >
        <p id="pwa-install-title" class="text-sm font-medium text-slate-900 dark:text-slate-100">
            Install Luminary Media Convert
        </p>
        <p class="text-sm text-slate-600 dark:text-slate-300">
            <template v-if="iosHint">
                Add this app to your home screen: tap Share, then “Add to Home Screen”.
            </template>
            <template v-else>
                Install the app for quick access from your desktop or taskbar.
            </template>
        </p>
        <div class="flex justify-end gap-2">
            <button
                type="button"
                class="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
                @click="dismiss"
            >
                Not now
            </button>
            <button
                v-if="canInstall && !iosHint"
                type="button"
                class="rounded-lg bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-60 dark:bg-sky-500 dark:hover:bg-sky-600"
                :disabled="installing"
                @click="install"
            >
                {{ installing ? 'Installing…' : 'Install' }}
            </button>
        </div>
    </div>
</template>
