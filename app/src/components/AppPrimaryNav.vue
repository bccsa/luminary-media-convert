<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();

function linkActive(pathCheck: 'sessions') {
    return pathCheck === 'sessions' && route.path.startsWith('/sessions');
}

function navLinkClass(active: boolean) {
    return [
        'inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium transition-colors sm:min-w-0 sm:px-3',
        'px-2 py-2 text-xs sm:text-sm',
        active
            ? 'bg-sky-50 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200'
            : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
    ].join(' ');
}

</script>

<template>
    <nav aria-label="Workspace" class="flex shrink-0 items-center gap-0.5 sm:gap-1">
        <router-link
            to="/sessions"
            :class="navLinkClass(linkActive('sessions'))"
            :aria-current="linkActive('sessions') ? 'page' : undefined"
            title="Sessions"
        >
            <svg class="h-5 w-5 shrink-0 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M8.25 6.75h12M8.25 12h12m-12 5.25h12" />
            </svg>
            <span class="sr-only sm:hidden">Sessions</span>
            <span class="hidden sm:inline">Sessions</span>
        </router-link>
    </nav>
</template>
