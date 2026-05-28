<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useAuth0 } from '@auth0/auth0-vue';
import { useTheme, type ThemePreference } from '../composables/useTheme';

const { user, logout } = useAuth0();
const { preference, setPreference } = useTheme();

const returnTo = window.location.origin;

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const themeOptions: { value: ThemePreference; label: string; description: string }[] = [
    { value: 'light', label: 'Light', description: 'Always light' },
    { value: 'system', label: 'Auto', description: 'Match system' },
    { value: 'dark', label: 'Dark', description: 'Always dark' },
];

const email = computed(() => user.value?.email ?? '');

const initials = computed(() => {
    const u = user.value;
    if (!u) return '?';
    const name = typeof u.name === 'string' ? u.name.trim() : '';
    if (name) {
        const parts = name.split(/\s+/).filter(Boolean);
        if (parts.length >= 2) {
            return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase();
        }
        return name.slice(0, 2).toUpperCase();
    }
    const em = typeof u.email === 'string' ? u.email.trim() : '';
    if (em) return em.slice(0, 2).toUpperCase();
    return '?';
});

function toggle() {
    open.value = !open.value;
}

function close() {
    open.value = false;
}

function onDocumentClick(e: MouseEvent) {
    const el = rootEl.value;
    if (!el || !(e.target instanceof Node)) return;
    if (!el.contains(e.target)) close();
}

function onDocumentKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
}

onMounted(() => {
    document.addEventListener('click', onDocumentClick);
});

onUnmounted(() => {
    document.removeEventListener('click', onDocumentClick);
    document.removeEventListener('keydown', onDocumentKeydown);
});

watch(open, (v) => {
    if (v) document.addEventListener('keydown', onDocumentKeydown);
    else document.removeEventListener('keydown', onDocumentKeydown);
});

function pickTheme(p: ThemePreference) {
    setPreference(p);
}

function signOut() {
    close();
    logout({ logoutParams: { returnTo } });
}
</script>

<template>
    <div ref="rootEl" class="relative shrink-0">
        <button
            type="button"
            class="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-xs font-semibold text-slate-800 shadow-sm ring-slate-900/5 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 dark:hover:bg-slate-700 dark:ring-white/10"
            :aria-expanded="open"
            aria-haspopup="true"
            aria-label="Account menu"
            @click.stop="toggle"
        >
            {{ initials }}
        </button>

        <Transition
            enter-active-class="transition duration-150 ease-out"
            enter-from-class="scale-95 opacity-0"
            enter-to-class="scale-100 opacity-100"
            leave-active-class="transition duration-100 ease-in"
            leave-from-class="scale-100 opacity-100"
            leave-to-class="scale-95 opacity-0"
        >
            <div
                v-if="open"
                class="absolute right-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-2rem))] origin-top-right rounded-xl border border-slate-200 bg-white py-1 shadow-xl ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800 dark:ring-white/10"
                role="menu"
                aria-label="Account"
                @click.stop
            >
                <div class="border-b border-slate-100 px-3 py-3 dark:border-slate-700">
                    <p class="text-xs font-medium text-slate-500 dark:text-slate-400">Signed in as</p>
                    <p class="mt-0.5 truncate text-sm font-medium text-slate-900 dark:text-slate-100" :title="email">
                        {{ email || '—' }}
                    </p>
                </div>

                <div class="px-2 py-2" role="none">
                    <p
                        id="account-appearance-label"
                        class="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500"
                    >
                        Appearance
                    </p>
                    <div class="space-y-0.5" role="group" aria-labelledby="account-appearance-label">
                        <button
                            v-for="opt in themeOptions"
                            :key="opt.value"
                            type="button"
                            role="menuitemradio"
                            :aria-checked="preference === opt.value"
                            class="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-800 transition-colors hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-700"
                            @click="pickTheme(opt.value)"
                        >
                            <span
                                class="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-slate-300 dark:border-slate-600"
                                aria-hidden="true"
                            >
                                <svg
                                    v-if="preference === opt.value"
                                    class="h-3 w-3 text-slate-600 dark:text-slate-400"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke="currentColor"
                                    stroke-width="2.5"
                                >
                                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                                </svg>
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="block font-medium">{{ opt.label }}</span>
                                <span class="block text-xs font-normal text-slate-500 dark:text-slate-400">{{
                                    opt.description
                                }}</span>
                            </span>
                        </button>
                    </div>
                </div>

                <div class="border-t border-slate-100 px-2 py-2 dark:border-slate-700">
                    <button
                        type="button"
                        role="menuitem"
                        class="flex w-full cursor-pointer items-center justify-center rounded-lg px-3 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                        @click="signOut"
                    >
                        Sign out
                    </button>
                </div>
            </div>
        </Transition>
    </div>
</template>
