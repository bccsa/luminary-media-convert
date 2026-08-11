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
    { drop: 'down', variant: 'default' },
);

const { preference, setPreference } = useTheme();

const open = ref(false);
const rootEl = ref<HTMLElement | null>(null);

const panelPositionClass = computed(() =>
    props.drop === 'up'
        ? 'bottom-full mb-2 origin-bottom-right'
        : 'top-full mt-2 origin-top-right',
);

const triggerClass = computed(() =>
    props.variant === 'editor'
        ? 'se-btn se-btn--icon cursor-pointer'
        : 'flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-slate-300 bg-slate-100 text-slate-700 shadow-sm ring-slate-900/5 transition-colors hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500/50 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:ring-white/10',
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
            'M12 3v1.5m0 15V21m9-9h-1.5m-15 0H3m15.36-6.36-1.06 1.06M6.7 17.3l-1.06 1.06m12.72 0-1.06-1.06M6.7 6.7 5.64 5.64',
            'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
        ],
    },
    {
        value: 'system',
        label: 'Auto',
        description: 'Match system',
        // Half-lit circle: the same glyph the Luminary app uses for "follow the
        // system", and the only one of the three that has to say "either".
        icon: [
            'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
            'M12 3v18a9 9 0 0 0 0-18Z',
        ],
    },
    {
        value: 'dark',
        label: 'Dark',
        description: 'Always dark',
        icon: ['M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z'],
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
                class="absolute right-0 z-50 w-[min(11rem,calc(100vw-2rem))] rounded-xl border border-slate-200 bg-white p-1 shadow-xl ring-1 ring-slate-900/5 dark:border-slate-700 dark:bg-slate-800 dark:ring-white/10"
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
