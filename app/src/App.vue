<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import AccountMenu from './components/AccountMenu.vue';
import AppPrimaryNav from './components/AppPrimaryNav.vue';
import { useAppLayout } from './composables/useAppLayout';

const route = useRoute();
const isSessionDetail = computed(() => route.name === 'session-detail');

const { headerLayout } = useAppLayout();

// Mirror the trimPlayerBreakoutClass max-width so the logo/nav left edge
// aligns with the player/title left edge at every viewport width.
const headerInnerClass = computed(() => {
    if (headerLayout.value === 'session-trim')
        return 'max-w-[96rem] px-4 sm:px-6';
    if (isSessionDetail.value) return 'max-w-7xl px-4 sm:px-6';
    return 'max-w-6xl px-4 sm:px-6';
});

const fillsViewport = computed(
    () =>
        headerLayout.value === 'session-trim' ||
        (isSessionDetail.value && headerLayout.value !== 'session')
);
</script>

<template>
    <div
        :class="[
            'relative',
            fillsViewport
                ? 'flex h-dvh flex-col overflow-hidden'
                : 'min-h-screen',
        ]"
    >
        <div
            class="pointer-events-none fixed inset-0 bg-gradient-to-b from-slate-50/90 via-sky-50/35 to-slate-100 dark:from-slate-950 dark:via-sky-950/35 dark:to-slate-950"
            aria-hidden="true"
        />
        <div
            class="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(56,189,248,0.14),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(14,165,233,0.14),transparent)]"
            aria-hidden="true"
        />

        <header
            class="sticky top-0 z-40 shrink-0 border-b border-sky-200/50 bg-white/90 font-sans shadow-sm backdrop-blur-md dark:border-sky-500/15 dark:bg-slate-900/85"
        >
            <div
                class="mx-auto flex min-h-14 w-full items-center gap-1.5 py-2 sm:gap-2 transition-[padding,max-width] duration-200"
                :class="headerInnerClass"
            >
                <!-- Session detail: back arrow teleported in from SessionView, sits before the brand -->
                <div
                    v-if="isSessionDetail"
                    id="app-session-meta-teleport"
                    class="flex shrink-0 items-center"
                />
                <span
                    v-if="isSessionDetail"
                    class="shrink-0 select-none text-base font-light text-slate-300 dark:text-slate-600 sm:text-lg"
                    aria-hidden="true"
                    >|</span
                >

                <router-link
                    to="/sessions"
                    class="flex shrink-0 items-center text-base font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-lg"
                >
                    <span class="sm:hidden">Luminary</span>
                    <span class="hidden sm:inline">Luminary Media Convert</span>
                </router-link>

                <AppPrimaryNav />

                <div class="min-w-0 flex-1" />

                <div
                    class="flex min-h-10 min-w-0 shrink-0 items-center justify-end gap-2 sm:gap-3"
                >
                    <div
                        v-if="isSessionDetail"
                        id="app-session-workflow-teleport"
                        class="flex min-w-0 max-w-[min(100vw-14rem,40rem)] items-center justify-end overflow-x-auto"
                    />
                    <AccountMenu />
                </div>
            </div>
        </header>

        <main
            class="relative mx-auto w-full transition-[padding,max-width] duration-200"
            :class="[
                fillsViewport
                    ? 'py-0 max-w-none px-0 min-h-0 flex-1 overflow-hidden'
                    : isSessionDetail
                      ? 'py-0 max-w-7xl px-4 sm:px-6'
                      : 'py-8 sm:py-10 max-w-6xl px-4 sm:px-6',
            ]"
        >
            <router-view />
        </main>
    </div>
</template>
