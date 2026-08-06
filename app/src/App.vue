<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAppLayout } from './composables/useAppLayout';

/**
 * There is no chrome above the content any more. The header held a brand, a nav
 * with a single link, the session's back arrow, its encode action and the
 * appearance menu — with one destination in the whole app, most of that was a
 * toolbar restating where you already were. What it genuinely carried moved to
 * where it belongs: the back arrow and session identity onto the row above the
 * player, the appearance menu into the timeline's own controls, and the encode
 * action alongside the session it acts on.
 */

const route = useRoute();
const isSessionDetail = computed(() => route.name === 'session-detail');

const { headerLayout } = useAppLayout();

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
