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
         * keyboard-shortcuts button. The utilities are copied from there and the
         * `se-btn` hooks are kept, so `.se-controls-bar .se-btn` still sizes both
         * to match and the two come out identical rather than merely similar.
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

/**
 * The editor's own icon-button styling, copied verbatim so this button and the
 * keyboard-shortcuts button beside it are identical rather than merely similar.
 * The `se-btn` classes are kept as hooks: `.se-controls-bar .se-btn` still sizes
 * both to match the row they sit in.
 */
const EDITOR_BUTTON =
    'appearance-none inline-flex items-center gap-1 px-2 py-1 text-xs font-medium font-[inherit] text-zinc-900 dark:text-slate-200 bg-slate-50 dark:bg-slate-800 border border-sky-200 dark:border-sky-400/12 rounded-md cursor-pointer transition-colors duration-[120ms] ease-[ease] enabled:hover:bg-slate-100 dark:enabled:hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:focus-visible:outline-sky-400 disabled:opacity-50 disabled:cursor-not-allowed';

const triggerClass = computed(() =>
    props.variant === 'editor'
        ? `se-btn se-btn--icon ${EDITOR_BUTTON}`
        : 'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-slate-700 shadow-sm ring-slate-900/5 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:ring-white/10'
);

/**
 * The three appearance choices, each with the icon that stands for it.
 *
 * `description` no longer prints as a second line — three mutually exclusive
 * options did not need one, and it was most of the panel's height — but it is
 * kept as the row's `title` and as its accessible name. "Auto" is the one label
 * that does not carry its own meaning, and losing the explanation entirely
 * would have made it a guess.
 */
const themeOptions: {
    value: ThemePreference;
    label: string;
    description: string;
    /** SVG path(s), drawn at 24×24 with a 1.75 stroke. */
    icon: string[];
}[] = [
    {
        value: 'light',
        label: 'Light',
        description: 'Always light',
        icon: [
            'M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z',
        ],
    },
    {
        value: 'system',
        label: 'Auto',
        description: 'Match system',
        // Half-lit circle: the same glyph the Luminary app uses for "follow the
        // system", and the only one of the three that has to say "either".
        icon: [
            'M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25m18 0v6.19a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 11.44V5.25',
        ],
    },
    {
        value: 'dark',
        label: 'Dark',
        description: 'Always dark',
        icon: [
            'M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z',
        ],
    },
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
    // Three mutually exclusive options: the choice is made, so the panel has
    // nothing left to offer. It used to stay open until dismissed, which read
    // as though the click had not registered.
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
                :class="
                    variant === 'editor'
                        ? 'inline-block h-[1.125rem] w-[1.125rem] shrink-0 align-middle text-[inherit]'
                        : 'h-5 w-5'
                "
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="1.75"
                aria-hidden="true"
            >
                <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"
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
            <!--
                Three rows, an icon each, no heading and no descriptions: the
                panel was 18rem wide and four rows tall for a choice between
                three words, and it opens from a sun icon that has already said
                what it is about.

                The checkmark column went with the descriptions, so selection is
                carried by the row's fill and an accent icon instead. What must
                not go with it is `role="menuitemradio"` + `aria-checked`, which
                is what tells a screen reader that these are three states of one
                setting rather than three buttons.
            -->
            <div
                v-if="open"
                class="absolute right-0 z-50 w-fit rounded-xl border border-slate-200 bg-white p-1 shadow-xl ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800 dark:ring-white/10"
                :class="panelPositionClass"
                role="menu"
                aria-label="Appearance"
                @click.stop
            >
                <div class="space-y-0.5" role="group" aria-label="Appearance">
                    <button
                        v-for="opt in themeOptions"
                        :key="opt.value"
                        type="button"
                        role="menuitemradio"
                        :aria-checked="preference === opt.value"
                        :aria-label="`${opt.label} — ${opt.description}`"
                        :title="opt.description"
                        class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors"
                        :class="
                            preference === opt.value
                                ? 'bg-sky-50 font-medium text-sky-900 dark:bg-sky-500/15 dark:text-sky-100'
                                : 'font-normal text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-700'
                        "
                        @click="pickTheme(opt.value)"
                    >
                        <svg
                            class="h-4 w-4 shrink-0"
                            :class="
                                preference === opt.value
                                    ? 'text-sky-600 dark:text-sky-400'
                                    : 'text-slate-400 dark:text-slate-500'
                            "
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="1.75"
                            aria-hidden="true"
                        >
                            <path
                                v-for="(d, i) in opt.icon"
                                :key="i"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                :d="d"
                            />
                        </svg>
                        {{ opt.label }}
                    </button>
                </div>
            </div>
        </Transition>
    </div>
</template>
