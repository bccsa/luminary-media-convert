<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { listSessions, deleteSession } from '../api';
import { setSessionToken, forgetSessionToken } from '../session-tokens';
import { clearChapterDraftForSession } from '../composables/useChapters';
import ProgressBar from '../components/ProgressBar.vue';
import AccountMenu from '../components/AccountMenu.vue';
import TrustedSitesPanel from '../components/TrustedSitesPanel.vue';
import { formatRelative } from '../utils/format';
import { errorMessage } from '../utils/errors';
import { isActiveStatus, isTerminalStatus, statusLabel } from '../utils/status';
import type { SessionSummary } from '../types';

const POLL_INTERVAL_MS = 3000;

const router = useRouter();

const sessions = ref<SessionSummary[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const dismissingId = ref<string | null>(null);
/** Row currently asking "are you sure?" — the dismiss confirm is inline, not a dialog. */
const confirmingId = ref<string | null>(null);

let pollTimer: ReturnType<typeof setInterval> | null = null;

// Solid pill colors per status. Labels come from utils/status.ts.
const statusColors: Record<string, string> = {
    created:
        'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400',
    uploading:
        'border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-600/50 dark:bg-cyan-900/40 dark:text-cyan-400',
    uploaded:
        'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400',
    queued: 'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/40 dark:text-amber-400',
    encoding:
        'border-slate-200 bg-slate-100 text-slate-900 dark:border-slate-500/35 dark:bg-slate-900/40 dark:text-slate-400',
    encrypting:
        'border-amber-200 bg-amber-100 text-amber-900 dark:border-amber-600/50 dark:bg-amber-900/40 dark:text-amber-400',
    uploading_to_s3:
        'border-cyan-200 bg-cyan-100 text-cyan-800 dark:border-cyan-600/50 dark:bg-cyan-900/40 dark:text-cyan-400',
    completed:
        'border-emerald-200 bg-emerald-100 text-emerald-900 dark:border-emerald-600/50 dark:bg-emerald-900/40 dark:text-emerald-400',
    failed: 'border-red-200 bg-red-100 text-red-800 dark:border-red-800/50 dark:bg-red-900/40 dark:text-red-400',
};

function badgeClasses(status: string): string {
    const color =
        statusColors[status] ??
        'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-400';
    return `inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${color}`;
}

function sessionLabel(session: SessionSummary): string {
    const title = session.title?.trim();
    if (title) return title;
    const hex = session.sessionId.replace(/-/g, '');
    return hex.length >= 8 ? `sess_${hex.slice(0, 8)}` : session.sessionId;
}

function createdLabel(session: SessionSummary): string {
    if (!session.createdAt) return '—';
    return formatRelative(new Date(session.createdAt).toISOString());
}

/**
 * Session tokens only come down with the list, so every refresh reseeds the map
 * the detail view reads. Cheap, and it means a deep link that lands cold can
 * simply ask for the list itself.
 */
async function fetchSessions(showSpinner = false) {
    if (showSpinner) loading.value = true;
    try {
        const result = await listSessions();
        sessions.value = result;
        for (const session of result) {
            setSessionToken(session.sessionId, session.sessionToken);
        }
        error.value = null;
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

function navigateToSession(id: string) {
    router.push(`/sessions/${id}`);
}

function askDismiss(id: string) {
    confirmingId.value = id;
}

function cancelDismiss() {
    confirmingId.value = null;
}

/**
 * Dismissing a finished session deletes it outright — that is the only way its
 * work directory is ever reclaimed. The output already lives in S3 and the CMS
 * already holds its URL, so nothing of value goes with it.
 */
async function confirmDismiss(id: string) {
    dismissingId.value = id;
    try {
        await deleteSession(id);
        clearChapterDraftForSession(id);
        forgetSessionToken(id);
        confirmingId.value = null;
        await fetchSessions();
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        dismissingId.value = null;
    }
}

onMounted(() => {
    fetchSessions(true);
    pollTimer = setInterval(fetchSessions, POLL_INTERVAL_MS);
});

onUnmounted(() => {
    if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
    <div class="app-view font-sans">
        <!--
            This page has no timeline to hang the appearance menu off, and with
            the header gone it would otherwise be unreachable from the one screen
            you always land on. It sits with the page heading instead.
        -->
        <div class="mb-6 flex items-start gap-4 lg:mb-8">
            <div class="min-w-0 flex-1 space-y-2">
                <h1
                    class="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-100"
                >
                    Encoding Sessions
                </h1>
                <p
                    class="max-w-xl text-sm leading-relaxed text-slate-500 dark:text-slate-400"
                >
                    Sessions opened from Luminary CMS, and what each one is doing
                    right now.
                </p>
            </div>
            <AccountMenu class="mt-1" />
        </div>

        <section
            class="overflow-hidden rounded-2xl border border-slate-200/90 bg-white/90 shadow-lg shadow-slate-900/5 ring-1 ring-slate-900/5 backdrop-blur-md dark:border-slate-700 dark:bg-slate-800/60 dark:shadow-black/20 dark:ring-white/10"
        >
            <div v-if="loading" class="flex justify-center py-20">
                <div class="flex flex-col items-center gap-3">
                    <div
                        class="flex h-12 w-12 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-950/40"
                    >
                        <svg
                            class="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400"
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
                    <p
                        class="text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                        Loading sessions…
                    </p>
                </div>
            </div>

            <template v-else>
                <div
                    v-if="error"
                    class="border-b border-slate-200/80 p-6 dark:border-slate-700"
                >
                    <div
                        class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-900/50 dark:bg-red-950/40"
                    >
                        <p class="text-sm text-red-800 dark:text-red-400">
                            {{ error }}
                        </p>
                    </div>
                </div>

                <ul
                    v-if="sessions.length > 0"
                    class="divide-y divide-slate-100 dark:divide-slate-800/80"
                >
                    <li
                        v-for="session in sessions"
                        :key="session.sessionId"
                        class="cursor-pointer px-4 py-4 transition-colors hover:bg-slate-50/90 sm:px-6 dark:hover:bg-slate-700/40"
                        @click="navigateToSession(session.sessionId)"
                    >
                        <div class="flex flex-wrap items-start gap-x-4 gap-y-2">
                            <div class="min-w-0 flex-1 space-y-2">
                                <div
                                    class="flex flex-wrap items-center gap-x-3 gap-y-1"
                                >
                                    <span
                                        class="min-w-0 truncate font-medium leading-snug text-slate-900 dark:text-slate-100"
                                        :title="session.sessionId"
                                    >
                                        {{ sessionLabel(session) }}
                                    </span>
                                    <span :class="badgeClasses(session.status)">
                                        <svg
                                            v-if="session.status === 'completed'"
                                            class="h-3.5 w-3.5 shrink-0 opacity-90"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            stroke-width="2.2"
                                            aria-hidden="true"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                        </svg>
                                        <svg
                                            v-else-if="
                                                session.status === 'failed'
                                            "
                                            class="h-3.5 w-3.5 shrink-0 opacity-90"
                                            fill="none"
                                            viewBox="0 0 24 24"
                                            stroke="currentColor"
                                            stroke-width="2.2"
                                            aria-hidden="true"
                                        >
                                            <path
                                                stroke-linecap="round"
                                                stroke-linejoin="round"
                                                d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                                            />
                                        </svg>
                                        <span
                                            v-else-if="
                                                isActiveStatus(session.status)
                                            "
                                            class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-80"
                                            aria-hidden="true"
                                        />
                                        {{ statusLabel(session.status) }}
                                    </span>
                                    <span
                                        class="shrink-0 text-xs text-slate-500 dark:text-slate-400"
                                    >
                                        {{ createdLabel(session) }}
                                    </span>
                                </div>

                                <ProgressBar
                                    v-if="isActiveStatus(session.status)"
                                    class="max-w-md"
                                    :label="statusLabel(session.status)"
                                    :progress="Math.round(session.progress ?? 0)"
                                />

                                <p
                                    v-if="
                                        session.status === 'failed' &&
                                        session.error
                                    "
                                    class="max-w-2xl text-xs leading-snug text-red-600 dark:text-red-400"
                                >
                                    {{ session.error }}
                                </p>
                            </div>

                            <div
                                v-if="isTerminalStatus(session.status)"
                                class="flex shrink-0 items-center gap-2"
                                @click.stop
                            >
                                <template
                                    v-if="confirmingId === session.sessionId"
                                >
                                    <span
                                        class="text-xs text-slate-500 dark:text-slate-400"
                                        >Dismiss?</span
                                    >
                                    <button
                                        type="button"
                                        class="inline-flex cursor-pointer rounded-lg border border-red-300 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800 transition-colors hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300 dark:hover:bg-red-950/70"
                                        :disabled="!!dismissingId"
                                        @click="
                                            confirmDismiss(session.sessionId)
                                        "
                                    >
                                        {{
                                            dismissingId === session.sessionId
                                                ? 'Dismissing…'
                                                : 'Yes, dismiss'
                                        }}
                                    </button>
                                    <button
                                        type="button"
                                        class="inline-flex cursor-pointer rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                        :disabled="!!dismissingId"
                                        @click="cancelDismiss"
                                    >
                                        Cancel
                                    </button>
                                </template>
                                <button
                                    v-else
                                    type="button"
                                    class="inline-flex cursor-pointer rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                    @click="askDismiss(session.sessionId)"
                                >
                                    Dismiss
                                </button>
                            </div>
                        </div>
                    </li>
                </ul>

                <div v-else-if="!error" class="px-6 py-16 text-center">
                    <p
                        class="text-sm font-medium text-slate-900 dark:text-slate-100"
                    >
                        No active sessions
                    </p>
                    <p class="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        Create one from Luminary CMS — it will appear here as
                        soon as it opens.
                    </p>
                </div>
            </template>
        </section>

        <!--
            App-level configuration, on the app's home rather than behind a
            route of its own — there is no nav to reach one with, and this is
            the screen every launch lands on.
        -->
        <TrustedSitesPanel class="mt-10 lg:mt-12" />
    </div>
</template>
