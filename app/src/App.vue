<script setup lang="ts">
import { provide, ref, watch } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { checkIdentity } from './api';
import AccountMenu from './components/AccountMenu.vue';

const { isAuthenticated, isLoading, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0();
const returnTo = window.location.origin;

const identityChecked = ref(false);
const identityError = ref<string | null>(null);
const encodingApiUrl = ref('');

provide('encodingApiUrl', encodingApiUrl);

watch(isAuthenticated, async (authenticated) => {
    if (!authenticated) {
        identityChecked.value = false;
        identityError.value = null;
        encodingApiUrl.value = '';
        return;
    }
    try {
        const token = await getAccessTokenSilently();
        const identity = await checkIdentity(token);
        encodingApiUrl.value = identity.encodingApiUrl ?? '';
        identityChecked.value = true;
    } catch (e) {
        identityError.value = e instanceof Error ? e.message : String(e);
    }
}, { immediate: true });
</script>

<template>
    <div class="relative min-h-screen">
        <div
            class="pointer-events-none fixed inset-0 bg-gradient-to-b from-indigo-50/90 via-zinc-50 to-zinc-100 dark:from-zinc-950 dark:via-zinc-950 dark:to-zinc-950"
            aria-hidden="true"
        />
        <div
            class="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.12),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(99,102,241,0.08),transparent)]"
            aria-hidden="true"
        />

        <!-- Loading state while Auth0 initializes or identity check runs -->
        <div
            v-if="isLoading || (isAuthenticated && !identityChecked && !identityError)"
            class="relative flex min-h-[calc(100vh-5rem)] items-center px-4 py-10 sm:py-14"
        >
            <div
                class="mx-auto w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white/90 p-8 text-center shadow-xl shadow-zinc-900/5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-black/20"
            >
                <div
                    class="mx-auto mb-4 inline-flex items-center rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-300"
                >
                    Luminary Media Convert
                </div>
                <div class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 dark:bg-indigo-950/40">
                    <svg class="h-6 w-6 animate-spin text-indigo-500 dark:text-indigo-400" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
                        <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                </div>
                <h2 class="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Loading your workspace</h2>
                <p class="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    Verifying authentication and preparing your session.
                </p>
                <div class="mt-5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                    <div class="loading-bar h-full w-1/3 rounded-full bg-indigo-500 dark:bg-indigo-400" />
                </div>
            </div>
        </div>

        <!-- Login prompt -->
        <div v-else-if="!isAuthenticated" class="relative flex min-h-[calc(100vh-5rem)] items-center px-4 py-10 sm:py-14">
            <div class="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
                <section class="text-left">
                    <div
                        class="mb-4 inline-flex items-center rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-xs font-medium text-zinc-600 shadow-sm dark:border-zinc-700 dark:bg-zinc-900/70 dark:text-zinc-300"
                    >
                        Luminary Media Convert
                    </div>
                    <h1 class="text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 sm:text-5xl">
                        Encode media with a clean, production-ready workflow
                    </h1>
                    <p class="mt-5 max-w-2xl text-base leading-relaxed text-zinc-600 dark:text-zinc-400 sm:text-lg">
                        Upload source files, configure ABR renditions, track progress in real time, and deliver HLS
                        output to S3 from one focused UI.
                    </p>
                </section>

                <section
                    class="mx-auto w-full max-w-md rounded-2xl border border-zinc-200/80 bg-white/90 p-8 shadow-xl shadow-zinc-900/5 backdrop-blur dark:border-zinc-800 dark:bg-zinc-900/70 dark:shadow-black/20"
                >
                    <h2 class="text-xl font-semibold text-zinc-900 dark:text-zinc-100">Sign in to continue</h2>
                    <p class="mt-2 text-base text-zinc-600 dark:text-zinc-400">
                        Authenticate with your workspace account to access sessions, API keys, and storage configs.
                    </p>
                    <button
                        type="button"
                        @click="loginWithRedirect()"
                        class="mt-6 inline-flex w-full cursor-pointer items-center justify-center rounded-xl bg-indigo-600 px-6 py-3.5 text-base font-semibold text-white transition-colors hover:bg-indigo-500"
                    >
                        Continue with Auth0
                    </button>
                    <p class="mt-3 text-center text-xs text-zinc-500 dark:text-zinc-400">
                        Secure sign-in via Auth0
                    </p>
                </section>
            </div>
        </div>

        <!-- Identity check failed (disabled, not provisioned, etc.) -->
        <div v-else-if="identityError" class="relative px-4 py-16 sm:py-24">
            <header class="mx-auto mb-10 max-w-lg text-center">
                <h1 class="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
                    Luminary Media Convert
                </h1>
            </header>
            <div
                class="mx-auto max-w-md rounded-2xl border border-red-200/80 bg-white/90 p-8 shadow-xl shadow-zinc-900/5 backdrop-blur dark:border-red-900/50 dark:bg-zinc-900/70 dark:shadow-black/20 text-center"
            >
                <p class="mb-6 text-sm text-red-600 dark:text-red-400">{{ identityError }}</p>
                <button
                    type="button"
                    @click="logout({ logoutParams: { returnTo } })"
                    class="inline-flex w-full cursor-pointer items-center justify-center rounded-xl border border-zinc-300 px-6 py-3 text-sm font-semibold text-zinc-800 transition-colors hover:bg-zinc-50 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
                >
                    Sign Out
                </button>
            </div>
        </div>

        <!-- Authenticated shell -->
        <template v-else>
            <header
                class="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/85 backdrop-blur-md dark:border-zinc-800 dark:bg-zinc-950/85"
            >
                <div class="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-6">
                    <router-link
                        to="/sessions"
                        class="shrink-0 text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-100"
                    >
                        Luminary
                    </router-link>

                    <nav class="flex min-w-0 flex-1 items-center gap-1 sm:gap-2" aria-label="Main">
                        <router-link
                            to="/sessions"
                            :class="[
                                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                                $route.path.startsWith('/sessions')
                                    ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                                    : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100',
                            ]"
                        >
                            Sessions
                        </router-link>
                        <router-link
                            to="/keys"
                            :class="[
                                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                                $route.path === '/keys'
                                    ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                                    : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100',
                            ]"
                        >
                            API Keys
                        </router-link>
                        <router-link
                            to="/s3-configs"
                            :class="[
                                'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                                $route.path === '/s3-configs'
                                    ? 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                                    : 'text-zinc-500 hover:bg-zinc-50 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100',
                            ]"
                        >
                            S3 Configs
                        </router-link>
                    </nav>

                    <AccountMenu />
                </div>
            </header>

            <main class="relative mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
                <router-view />
            </main>
        </template>
    </div>
</template>
