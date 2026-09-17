<script setup lang="ts">
/**
 * ISO 639-2 language picker: the form's `SelectMenu`, searchable, over the
 * whole register.
 *
 * Not a `<datalist>`. Electron draws datalist suggestions itself, in the main
 * process, as one unscrollable popup sized to every option — 506 rows, ~12,000
 * px tall, rebuilt on every keystroke — and that froze the whole app.
 */
import { computed } from 'vue';
import SelectMenu, { type SelectMenuOption } from './SelectMenu.vue';
import {
    isValidLanguageCode,
    LANGUAGE_OPTIONS,
    languageName,
    normalizeLanguageInput,
} from './language-codes';

const props = withDefaults(
    defineProps<{
        modelValue?: string | null;
        placeholder?: string;
        disabled?: boolean;
        ariaLabel?: string;
    }>(),
    {
        modelValue: undefined,
        placeholder: 'und',
        disabled: false,
        ariaLabel: 'Language',
    },
);

const emit = defineEmits<{
    'update:modelValue': [value: string];
}>();

const LOCAL_USE_RANGE = /^q[a-t][a-z]$/;

const OPTIONS: readonly SelectMenuOption[] = [
    { value: '', code: '', label: 'Not specified' },
    ...LANGUAGE_OPTIONS.map(([code, name]) => ({ value: code, code, label: name })),
];

const current = computed(() => normalizeLanguageInput(props.modelValue));

const title = computed(() => {
    if (current.value === '') return 'ISO 639-2 three-letter code, e.g. eng';
    const name = languageName(current.value);
    if (name) return `${current.value} — ${name}`;
    if (LOCAL_USE_RANGE.test(current.value))
        return `${current.value} — local use`;
    return `${current.value} is not an ISO 639-2 code`;
});

/**
 * A code already stored that the list cannot offer — a local-use code, or a
 * bad one read from the source — still needs to show as selected.
 */
const options = computed<readonly SelectMenuOption[]>(() =>
    current.value === '' || OPTIONS.some((o) => o.value === current.value)
        ? OPTIONS
        : [...OPTIONS, { value: current.value, code: current.value, label: title.value }],
);

/**
 * Exact code first, then codes that start with the query, then names that
 * start with it, then names that merely contain it — so `ger` puts German on
 * top while `man` still finds Mandarin, Manx and Romansh.
 */
function filter(query: string): readonly SelectMenuOption[] {
    const q = normalizeLanguageInput(query);
    const ranked: { option: SelectMenuOption; rank: number }[] = [];
    for (const option of OPTIONS) {
        if (option.value === '') continue;
        const code = String(option.value);
        const name = option.label.toLowerCase();
        let rank = -1;
        if (code === q) rank = 0;
        else if (code.startsWith(q)) rank = 1;
        else if (name.startsWith(q)) rank = 2;
        else if (name.includes(q)) rank = 3;
        if (rank >= 0) ranked.push({ option, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank);
    const out = ranked.map((r) => r.option);
    if (LOCAL_USE_RANGE.test(q)) out.unshift({ value: q, code: q, label: 'Local use' });
    return out;
}
</script>

<template>
    <SelectMenu
        :model-value="current"
        :options="options"
        :display-value="current"
        :placeholder="placeholder"
        :disabled="disabled"
        :aria-label="ariaLabel"
        :invalid="!isValidLanguageCode(current)"
        :title="title"
        searchable
        search-placeholder="Search language or code"
        :filter="filter"
        no-match-text="No language matches"
        class="ecf-menu-trigger--code"
        data-language-select
        @update:model-value="emit('update:modelValue', String($event))"
    />
</template>
