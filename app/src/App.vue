<script setup lang="ts">
import { computed, provide, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth0 } from '@auth0/auth0-vue';
import { checkIdentity } from './api';
import AccountMenu from './components/AccountMenu.vue';
import AppPrimaryNav from './components/AppPrimaryNav.vue';
import { useAppLayout } from './composables/useAppLayout';
import { errorMessage } from './utils/errors';

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

const {
    isAuthenticated,
    isLoading,
    loginWithRedirect,
    logout,
    getAccessTokenSilently,
} = useAuth0();
const returnTo = window.location.origin;

const identityChecked = ref(false);
const identityError = ref<string | null>(null);
const encodingApiUrl = ref('');

provide('encodingApiUrl', encodingApiUrl);

watch(
    isAuthenticated,
    async (authenticated) => {
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
            identityError.value = errorMessage(e);
        }
    },
    { immediate: true }
);
</script>

<template>
    <div class="relative min-h-screen">
        <div
            class="pointer-events-none fixed inset-0 bg-gradient-to-b from-slate-50/90 via-sky-50/35 to-slate-100 dark:from-slate-950 dark:via-sky-950/35 dark:to-slate-950"
            aria-hidden="true"
        />
        <div
            class="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(56,189,248,0.14),transparent)] dark:bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(14,165,233,0.14),transparent)]"
            aria-hidden="true"
        />

        <!-- Loading state while Auth0 initializes or identity check runs -->
        <div
            v-if="
                isLoading ||
                (isAuthenticated && !identityChecked && !identityError)
            "
            class="relative flex min-h-[calc(100vh-5rem)] items-center px-4 py-10 sm:py-14"
        >
            <div
                class="mx-auto w-full max-w-md rounded-2xl border border-slate-200/80 bg-white/90 p-8 text-center shadow-xl shadow-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/70 dark:shadow-black/20"
            >
                <div
                    class="mx-auto mb-4 inline-flex items-center rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300"
                >
                    Luminary Media Convert
                </div>
                <div
                    class="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 dark:bg-sky-950/40"
                >
                    <svg
                        class="h-6 w-6 animate-spin text-slate-500 dark:text-sky-400"
                        fill="none"
                        viewBox="0 0 24 24"
                    >
                        <circle
                            class="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            stroke-width="4"
                        />
                        <path
                            class="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                    </svg>
                </div>
                <h2
                    class="text-lg font-semibold text-slate-900 dark:text-slate-100"
                >
                    Loading your workspace
                </h2>
                <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
                    Verifying authentication and preparing your session.
                </p>
                <div
                    class="mt-5 h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
                >
                    <div
                        class="loading-bar h-full w-1/3 rounded-full bg-sky-500 dark:bg-sky-400"
                    />
                </div>
            </div>
        </div>

        <!-- Login prompt -->
        <div
            v-else-if="!isAuthenticated"
            class="relative flex min-h-[calc(100vh-5rem)] items-center px-4 py-8 sm:py-10"
        >
            <div
                class="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-2 lg:items-center"
            >
                <!-- Hero Section with Visual -->
                <section class="text-left">
                    <div
                        class="mb-4 inline-flex items-center rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300"
                    >
                        Luminary Media Convert
                    </div>

                    <h1
                        class="text-4xl font-bold tracking-tight text-slate-900 dark:text-slate-100 sm:text-5xl leading-tight"
                    >
                        Encode media with a clean, production-ready workflow
                    </h1>

                    <p
                        class="mt-3 max-w-2xl text-base leading-relaxed text-slate-600 dark:text-slate-400"
                    >
                        Upload source files, configure ABR renditions, track
                        progress in real time, and deliver HLS output to S3 from
                        one focused UI.
                    </p>

                    <!-- Feature Highlights -->
                    <ul class="mt-6 space-y-2">
                        <li class="flex items-start gap-3">
                            <svg
                                class="mt-1 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                            >
                                <path
                                    fill-rule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                    clip-rule="evenodd"
                                />
                            </svg>
                            <span
                                class="text-sm text-slate-700 dark:text-slate-300"
                                ><strong>GPU-accelerated encoding</strong></span
                            >
                        </li>
                        <li class="flex items-start gap-3">
                            <svg
                                class="mt-1 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                            >
                                <path
                                    fill-rule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                    clip-rule="evenodd"
                                />
                            </svg>
                            <span
                                class="text-sm text-slate-700 dark:text-slate-300"
                                ><strong>Multi-format HLS output</strong> — ABR
                                renditions, encryption & byte-range
                                packing</span
                            >
                        </li>
                        <li class="flex items-start gap-3">
                            <svg
                                class="mt-1 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                            >
                                <path
                                    fill-rule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                    clip-rule="evenodd"
                                />
                            </svg>
                            <span
                                class="text-sm text-slate-700 dark:text-slate-300"
                                ><strong>Real-time progress</strong> — Live
                                encoding status, webhooks & event streams</span
                            >
                        </li>
                        <li class="flex items-start gap-3">
                            <svg
                                class="mt-1 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                            >
                                <path
                                    fill-rule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                    clip-rule="evenodd"
                                />
                            </svg>
                            <span
                                class="text-sm text-slate-700 dark:text-slate-300"
                                ><strong>S3-native delivery</strong> — MinIO,
                                AWS, Cloudflare R2, Backblaze B2
                                compatible</span
                            >
                        </li>
                        <li class="flex items-start gap-3">
                            <svg
                                class="mt-1 h-5 w-5 shrink-0 text-sky-600 dark:text-sky-400"
                                fill="currentColor"
                                viewBox="0 0 20 20"
                            >
                                <path
                                    fill-rule="evenodd"
                                    d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                                    clip-rule="evenodd"
                                />
                            </svg>
                            <span
                                class="text-sm text-slate-700 dark:text-slate-300"
                                ><strong>Well-documented API</strong> —
                                OpenAPI-backed REST and webhooks so you can
                                integrate it cleanly into your stack</span
                            >
                        </li>
                    </ul>
                </section>

                <!-- Auth Card -->
                <section
                    class="mx-auto w-full max-w-md rounded-2xl border border-slate-200/80 bg-white/90 p-8 shadow-xl shadow-slate-900/5 backdrop-blur dark:border-slate-700 dark:bg-slate-800/70 dark:shadow-black/20"
                >
                    <h2
                        class="text-2xl font-bold text-slate-900 dark:text-slate-100"
                    >
                        Sign in
                    </h2>
                    <p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
                        Authenticate with your workspace account to access
                        sessions, API keys, and storage configs.
                    </p>

                    <button
                        type="button"
                        @click="loginWithRedirect()"
                        class="mt-8 inline-flex w-full cursor-pointer items-center justify-center rounded-lg bg-slate-900 px-6 py-3 text-base font-semibold text-white transition-colors hover:bg-slate-800 dark:bg-sky-700 dark:hover:bg-sky-600"
                    >
                        <svg
                            class="mr-2 h-5 w-5"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2"
                        >
                            <path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                d="M13 10V3L4 14h7v7l9-11h-7z"
                            />
                        </svg>
                        Login
                    </button>
                </section>
            </div>
        </div>

        <!-- Identity check failed (disabled, not provisioned, etc.) -->
        <div v-else-if="identityError" class="relative px-4 py-16 sm:py-24">
            <header class="mx-auto mb-10 max-w-lg text-center">
                <h1
                    class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100"
                >
                    Luminary Media Convert
                </h1>
            </header>
            <div
                class="mx-auto max-w-md rounded-2xl border border-red-200/80 bg-white/90 p-8 shadow-xl shadow-slate-900/5 backdrop-blur dark:border-red-900/50 dark:bg-slate-800/70 dark:shadow-black/20 text-center"
            >
                <p class="mb-6 text-sm text-red-600 dark:text-red-400">
                    {{ identityError }}
                </p>
                <button
                    type="button"
                    @click="logout({ logoutParams: { returnTo } })"
                    class="inline-flex w-full cursor-pointer items-center justify-center rounded-xl border border-slate-300 px-6 py-3 text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                    Sign Out
                </button>
            </div>
        </div>

        <!-- Authenticated shell -->
        <template v-else>
            <header
                class="sticky top-0 z-40 border-b border-sky-200/50 bg-white/90 font-sans shadow-sm backdrop-blur-md dark:border-sky-500/15 dark:bg-slate-900/85"
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
                        <span class="hidden sm:inline"
                            >Luminary Media Convert</span
                        >
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
                    headerLayout === 'session-trim' ||
                    (isSessionDetail && headerLayout !== 'session')
                        ? 'py-0 max-w-none px-0 h-[calc(100dvh-3.5rem)] overflow-hidden'
                        : isSessionDetail
                          ? 'py-0 max-w-7xl px-4 sm:px-6'
                          : 'py-8 sm:py-10 max-w-6xl px-4 sm:px-6',
                ]"
            >
                <router-view />
            </main>
        </template>
    </div>
</template>
