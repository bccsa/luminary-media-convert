<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { listOrigins, revokeOrigin, type OriginDecisions } from '../api';
import { errorMessage } from '../utils/errors';

/**
 * Review and undo which sites may use this encoder.
 *
 * Decisions are made once, in a native dialog, and were then unreachable: a
 * user who clicked "Block" on their own CMS was locked out of their own
 * encoder with no route back inside the product — only a settings file to find
 * and edit by hand. Unblocking is the reason this exists; revoking an allow is
 * the same control read the other way.
 */

const decisions = ref<OriginDecisions>({ allowed: [], denied: [] });
const loading = ref(true);
const error = ref<string | null>(null);
/** The origin currently being revoked, so only its own row shows the wait. */
const busy = ref<string | null>(null);

/**
 * Only when we actually know it. "No site has asked yet" is a claim about the
 * world, and a failed request is not evidence for it — saying it beside a
 * connection error told the user something reassuring and false.
 */
const isEmpty = computed(
    () =>
        !error.value &&
        !decisions.value.allowed.length &&
        !decisions.value.denied.length,
);

async function load() {
    try {
        decisions.value = await listOrigins();
        error.value = null;
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        loading.value = false;
    }
}

async function revoke(origin: string) {
    busy.value = origin;
    try {
        await revokeOrigin(origin);
        // Re-read rather than splice locally: the API is the holder of the
        // answer, and a decision could have been made in a dialog since.
        await load();
    } catch (e) {
        error.value = errorMessage(e);
    } finally {
        busy.value = null;
    }
}

onMounted(load);
</script>

<template>
    <section class="space-y-4">
        <div class="space-y-1">
            <h2 class="text-base font-semibold text-slate-900 dark:text-slate-100">
                Sites allowed to use this encoder
            </h2>
            <p class="max-w-2xl text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                A site is added here the first time it asks and you answer. Removing
                one makes this encoder forget the decision: an allowed site is shut
                out, and a blocked site may ask again the next time it calls.
            </p>
        </div>

        <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

        <p v-if="loading" class="text-sm text-slate-500 dark:text-slate-400">
            Loading…
        </p>

        <p
            v-else-if="isEmpty"
            class="text-sm text-slate-500 dark:text-slate-400"
        >
            No site has asked yet. The first one to do so will raise a dialog.
        </p>

        <template v-else>
            <div v-for="group in ([
                { key: 'allowed', label: 'Allowed', items: decisions.allowed },
                { key: 'denied', label: 'Blocked', items: decisions.denied },
            ] as const)" :key="group.key">
                <div v-if="group.items.length" class="space-y-2">
                    <h3
                        class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500"
                    >
                        {{ group.label }}
                    </h3>
                    <ul
                        class="divide-y divide-slate-200/80 overflow-hidden rounded-xl border border-slate-200/90 bg-white/90 dark:divide-slate-700 dark:border-slate-700 dark:bg-slate-800/60"
                    >
                        <li
                            v-for="origin in group.items"
                            :key="origin"
                            class="flex items-center gap-3 px-4 py-3"
                        >
                            <span
                                class="min-w-0 flex-1 truncate font-mono text-sm text-slate-700 dark:text-slate-200"
                                :title="origin"
                            >{{ origin }}</span>
                            <button
                                type="button"
                                class="shrink-0 cursor-pointer rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                                :disabled="busy === origin"
                                @click="revoke(origin)"
                            >
                                {{ busy === origin ? 'Removing…' : 'Remove' }}
                            </button>
                        </li>
                    </ul>
                </div>
            </div>
        </template>
    </section>
</template>
