<script setup lang="ts">
import StatusBadge from '../StatusBadge.vue';
import { formatRelative } from '../../utils/format';
import { statusLabel } from '../../utils/status';

/**
 * Where you are, what this session is, and the one destructive action on it.
 *
 * A component rather than markup in the view because it renders in two places
 * and must: inside the player's column once there is a player, and on its own
 * during the stretch from `created` to `uploaded`, when there is no player yet.
 * That stretch is exactly where there was previously no way out of the session at
 * all, so the back arrow and the discard button cannot live only in the version
 * that needs a video.
 *
 * The encode action deliberately is *not* here. It used to sit at the right-hand
 * end of this row, which was the furthest point on screen from the settings it
 * acts on; it now lives under the player, beside them.
 */
const props = defineProps<{
    /** Falls back to a placeholder; the id is the tooltip either way. */
    sessionName?: string | null;
    sessionId: string;
    status: string | null;
    createdAt?: number | null;
    /** Show the immediate discard — a session mid-setup, or an encode to cancel. */
    canDiscard: boolean;
    /** "Cancel encoding" once there is an encode; "Discard session" before that. */
    discardLabel: string;
    /** Show delete-with-confirmation, for a session that has finished. */
    canDelete: boolean;
    /** Why the last discard did not work. Shown inline; a swallowed refusal reads as success. */
    cancelError?: string | null;
}>();

const emit = defineEmits<{ discard: []; delete: [] }>();

/**
 * Status text and border colours for the badge.
 *
 * Local to this row rather than in `utils/status` beside the labels, because the
 * session list draws the same statuses with a different treatment — sharing the
 * colours would couple two surfaces that have never agreed on them.
 */
const statusColors: Record<string, { color: string; borderColor: string }> = {
    created: {
        color: 'text-slate-700 dark:text-slate-400',
        borderColor: 'border-slate-300 dark:border-slate-700',
    },
    uploading: {
        color: 'text-cyan-700 dark:text-cyan-400',
        borderColor: 'border-cyan-300 dark:border-cyan-700/60',
    },
    uploaded: {
        color: 'text-slate-700 dark:text-slate-400',
        borderColor: 'border-slate-300 dark:border-slate-700',
    },
    queued: {
        color: 'text-amber-700 dark:text-amber-400',
        borderColor: 'border-amber-300 dark:border-amber-700/60',
    },
    encoding: {
        color: 'text-sky-700 dark:text-sky-400',
        borderColor: 'border-sky-300 dark:border-sky-700/60',
    },
    encrypting: {
        color: 'text-sky-700 dark:text-sky-400',
        borderColor: 'border-sky-300 dark:border-sky-700/60',
    },
    uploading_to_s3: {
        color: 'text-sky-700 dark:text-sky-400',
        borderColor: 'border-sky-300 dark:border-sky-700/60',
    },
    completed: {
        color: 'text-emerald-700 dark:text-emerald-400',
        borderColor: 'border-emerald-300 dark:border-emerald-700/60',
    },
    failed: {
        color: 'text-red-700 dark:text-red-400',
        borderColor: 'border-red-300 dark:border-red-800/60',
    },
};

function createdLabel(createdAt: number | null | undefined): string {
    if (!createdAt) return '';
    return `Created ${formatRelative(new Date(createdAt).toISOString())}`;
}
</script>

<template>
    <div
        class="session-topline flex min-w-0 shrink-0 items-center gap-2 pb-2"
        data-testid="session-topline"
    >
        <router-link
            to="/sessions"
            class="inline-flex shrink-0 items-center justify-center rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            title="Back to sessions"
        >
            <svg
                class="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2.25"
                aria-hidden="true"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M15 19l-7-7 7-7"
                />
            </svg>
            <span class="sr-only">Back to sessions</span>
        </router-link>

        <span
            class="shrink-0 select-none text-base font-light text-slate-300 dark:text-slate-600"
            aria-hidden="true"
            >|</span
        >

        <span
            class="min-w-0 truncate text-base font-semibold text-slate-800 dark:text-slate-100"
            :title="props.sessionName || props.sessionId"
        >
            {{ props.sessionName || 'Untitled session' }}
        </span>

        <template v-if="props.status">
            <span
                class="shrink-0 text-slate-300 dark:text-slate-600"
                aria-hidden="true"
                >·</span
            >
            <StatusBadge
                class="shrink-0"
                :label="statusLabel(props.status)"
                :color="statusColors[props.status]?.color"
                :border-color="statusColors[props.status]?.borderColor"
            />
        </template>

        <template v-if="props.createdAt">
            <span
                class="shrink-0 text-slate-300 dark:text-slate-600"
                aria-hidden="true"
                >·</span
            >
            <span class="shrink-0 text-xs text-slate-500 dark:text-slate-400">
                {{ createdLabel(props.createdAt) }}
            </span>
        </template>

        <div class="min-w-0 flex-1" />

        <span
            v-if="props.cancelError"
            data-testid="discard-error"
            class="min-w-0 max-w-[18rem] truncate text-xs text-red-600 dark:text-red-400"
            :title="props.cancelError"
            >{{ props.cancelError }}</span
        >

        <!--
            Discard now, or delete with a confirmation. Never both: a session is
            either still going, in which case stopping it is the honest action, or
            it has finished, in which case what is left to remove is a record and
            a work directory.
        -->
        <button
            v-if="props.canDiscard"
            type="button"
            data-testid="discard-session"
            class="shrink-0 cursor-pointer rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40"
            @click="emit('discard')"
        >
            {{ props.discardLabel }}
        </button>
        <button
            v-else-if="props.canDelete"
            type="button"
            data-testid="delete-session"
            class="shrink-0 cursor-pointer rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-900/50 dark:bg-transparent dark:text-red-400 dark:hover:bg-red-950/40"
            @click="emit('delete')"
        >
            Delete session
        </button>
    </div>
</template>
