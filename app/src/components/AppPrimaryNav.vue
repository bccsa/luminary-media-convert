<script setup lang="ts">
import { useRoute } from 'vue-router';

const route = useRoute();

function linkActive(pathCheck: 'sessions' | 'keys' | 's3') {
    if (pathCheck === 'sessions') return route.path.startsWith('/sessions');
    if (pathCheck === 'keys') return route.path === '/keys';
    return route.path === '/s3-configs';
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

        <router-link
            to="/keys"
            :class="navLinkClass(linkActive('keys'))"
            :aria-current="linkActive('keys') ? 'page' : undefined"
            title="API Keys"
        >
            <svg class="h-5 w-5 shrink-0 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15.75 5.25a3 3 0 013 3m3 0a6 6 0 01-7.029 5.912l-.003-.002c-.137-.072-.293-.113-.462-.113h-.004a1.125 1.125 0 01-1.122-1.118v-.004c0-.171.04-.329.114-.461l.002-.003A6 6 0 1121.75 8.25zm-9.75 9.75h.008v.008H6v-.008z" />
            </svg>
            <span class="sr-only sm:hidden">API Keys</span>
            <span class="hidden sm:inline">API Keys</span>
        </router-link>

        <router-link
            to="/s3-configs"
            :class="navLinkClass(linkActive('s3'))"
            :aria-current="linkActive('s3') ? 'page' : undefined"
            title="Storage configs"
        >
            <svg class="h-5 w-5 shrink-0 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.75" aria-hidden="true">
                <path stroke-linecap="round" stroke-linejoin="round" d="M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3V6.75m16.5 4.5v4.5a3 3 0 01-3 3M5.25 14.25v4.125c0 .621.504 1.125 1.125 1.125h11.25m0 0h.008v.008M19.5 19.5v.008m-.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0v.008m-.375 0h.375m-12 0h-.375m0 0v-.008m.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0v.008M9 19.5v.008m0 0h.008m-.008 0a.375.375 0 11.75 0 .375.375 0 01-.75 0zm3 0h.008m-.008 0a.375.375 0 11.75 0 .375.375 0 01-.75 0zm3 0h.008m-.008 0a.375.375 0 11.75 0 .375.375 0 01-.75 0z" />
            </svg>
            <span class="sr-only sm:hidden">Storage configs</span>
            <span class="hidden sm:inline">Storage</span>
        </router-link>
    </nav>
</template>
