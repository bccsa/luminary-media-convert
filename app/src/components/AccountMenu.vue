<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useTheme, type ThemePreference } from '../composables/useTheme';

/**
 * Appearance menu. There is no account any more — the app runs locally with no
 * sign-in — so what was the account menu keeps its place and its shape, and
 * carries the one setting that was ever really in it.
 */

const props = withDefaults(
    defineProps<{
        /**
         * Which way the panel opens. It lives in the timeline's controls at the
         * very bottom of the window on the session view, where a panel dropping
         * downwards opens past the edge of the screen.
         */
        drop?: 'down' | 'up';
        /**
         * `editor` borrows the segment editor's own button styling, for the
         * instance that sits in the timeline's controls bar next to the
         * keyboard-shortcuts button. Those classes are injected globally by the
         * library, and `.se-controls-bar .se-btn` sizes them to match, so the
         * two buttons come out identical rather than merely similar.
         */
        variant?: 'default' | 'editor';
    }>(),
    { drop: 'down', variant: 'default' }
);

const { preference, setPreference } = useTheme();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const panelPositionClass = computed(() =>
    props.drop === 'up'
        ? 'bottom-full mb-2 origin-bottom-right'
        : 'top-full mt-2 origin-top-right'
);

const triggerClass = computed(() =>
    props.variant === 'editor'
        ? 'se-btn se-btn--icon cursor-pointer'
        : 'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-slate-700 shadow-sm ring-slate-900/5 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:ring-white/10'
);

const themeOptions: {
    value: ThemePreference;
    label: string;
}[] = [
    { value: 'light', label: 'Light' },
    { value: 'system', label: 'Auto' },
    { value: 'dark', label: 'Dark' },
];

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
    close();
}
</script>

<template>
    <div ref="rootEl" class="relative shrink-0">
        <button
            type="button"
            :class="triggerClass"
            :aria-expanded="open"
            aria-haspopup="true"
            aria-label="Appearance"
            title="Appearance"
            @click.stop="toggle"
        >
            <svg
                :class="variant === 'editor' ? 'se-icon' : 'h-5 w-5'"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.75"
                aria-hidden="true"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 3v1.5m0 15V21m9-9h-1.5m-15 0H3m15.36-6.36-1.06 1.06M6.7 17.3l-1.06 1.06m12.72 0-1.06-1.06M6.7 6.7 5.64 5.64M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
                />
            </svg>
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
                class="absolute right-0 z-50 w-fit rounded-xl border border-slate-200 bg-white py-1 shadow-xl ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800 dark:ring-white/10"
                :class="panelPositionClass"
                role="menu"
                aria-label="Appearance"
                @click.stop
            >
                <div class="px-2 py-2" role="none">
                    <p
                        id="account-appearance-label"
                        class="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500"
                    >
                        Appearance
                    </p>
                    <div
                        class="space-y-0.5"
                        role="group"
                        aria-labelledby="account-appearance-label"
                    >
                        <button
                            v-for="opt in themeOptions"
                            :key="opt.value"
                            type="button"
                            role="menuitemradio"
                            :aria-checked="preference === opt.value"
                            :class="[
                                'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-slate-800 transition-colors hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700',
                                preference === opt.value
                                    ? 'bg-slate-100 dark:bg-slate-700'
                                    : '',
                            ]"
                            @click="pickTheme(opt.value)"
                        >
                            <span
                                class="flex h-4 w-4 shrink-0 items-center justify-center"
                                aria-hidden="true"
                            >
                                <svg
                                    v-if="opt.label === 'Light'"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="1.5"
                                    stroke="currentColor"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
                                    />
                                </svg>
                                <svg
                                    v-if="opt.label === 'Auto'"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="1.5"
                                    stroke="currentColor"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0v6.19a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 11.44V5.25"
                                    />
                                </svg>

                                <svg
                                    v-if="opt.label === 'Dark'"
                                    xmlns="http://www.w3.org/2000/svg"
                                    fill="none"
                                    viewBox="0 0 24 24"
                                    stroke-width="1.5"
                                    stroke="currentColor"
                                >
                                    <path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"
                                    />
                                </svg>
                            </span>
                            <span class="min-w-0 flex-1">
                                <span class="block font-medium">{{
                                    opt.label
                                }}</span>
                            </span>
                        </button>
                    </div>
                </div>
            </div>
        </Transition>
    </div>
</template>
