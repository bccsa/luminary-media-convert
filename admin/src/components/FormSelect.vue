<script setup lang="ts">
import { computed } from 'vue';
import FormSelectListbox from './FormSelectListbox.vue';

/**
 * Admin twin of `app/src/components/FormSelect.vue` — defaults to **`variant=\"admin\"`**.
 */

export type SelectOption = {
    value: string | number;
    label: string;
    disabled?: boolean;
};

type Model = string | number | null | undefined;

const props = withDefaults(
    defineProps<{
        options: SelectOption[];
        modelValue?: Model;
        placeholder?: string;
        /** When false, placeholder row stays selectable (`value=""`). Default: disabled first row */
        placeholderDisabled?: boolean;
        /** Emit numeric `modelValue` for non-empty values (tracks / indices). */
        numeric?: boolean;
        id?: string;
        disabled?: boolean;
        name?: string;
        autocomplete?: string;
        ariaLabel?: string;
        variant?: 'field' | 'playback' | 'admin';
        /**
         * `auto` → custom panel for `field` / `admin`, native `<select>` for `playback`.
         * `custom` → always themed list panel.
         * `native` → always OS `<select>` (open list styled by OS).
         */
        presentation?: 'auto' | 'native' | 'custom';
        /** Merged after variant base styles (width, etc.). */
        selectClass?: string;
        /** Extra classes on the outer wrapper (layout, max-width, flex). */
        wrapperClass?: string;
        /** Compact control (field + admin). Playback unchanged. */
        size?: 'sm' | 'md';
        /** Error / invalid visual state (field + admin). */
        invalid?: boolean;
        /** Explicitly disable chevron overlay (field variant only — native branch). */
        hideChevron?: boolean;
    }>(),
    {
        modelValue: undefined,
        placeholderDisabled: true,
        numeric: false,
        variant: 'admin',
        presentation: 'auto',
        selectClass: '',
        wrapperClass: '',
        size: 'md',
        invalid: false,
        hideChevron: false,
    },
);

const emit = defineEmits<{
    'update:modelValue': [value: string | number];
    change: [e: Event];
}>();

const useListbox = computed(() => {
    if (props.presentation === 'native') return false;
    if (props.presentation === 'custom') return true;
    return props.variant !== 'playback';
});

const listboxBindings = computed(() => ({
    modelValue: props.modelValue,
    options: props.options,
    placeholder: props.placeholder,
    placeholderDisabled: props.placeholderDisabled,
    numeric: props.numeric,
    id: props.id,
    disabled: props.disabled,
    name: props.name,
    ariaLabel: props.ariaLabel,
    variant: props.variant,
    selectClass: props.selectClass,
    wrapperClass: props.wrapperClass,
    size: props.size,
    invalid: props.invalid,
    hideChevron: props.hideChevron,
}));

function onListboxChange(v: string | number) {
    emit('update:modelValue', v);
    emit('change', new Event('change', { bubbles: true }));
}

function domString(value: Model): string {
    if (value === null || value === undefined) return '';
    return String(value);
}

function coerceFromDom(raw: string): string | number {
    if (props.numeric && raw !== '') {
        const n = Number(raw);
        if (!Number.isNaN(n)) return n;
    }
    return raw;
}

const invalidClass = computed(() => {
    if (!props.invalid) return '';
    switch (props.variant) {
        case 'playback':
            return 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500/40 dark:border-red-500';
        case 'admin':
            return 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500/40';
        default:
            return 'border-red-500 focus:border-red-500 focus:ring-red-500/25 dark:border-red-500/60 dark:focus:ring-red-500/30';
    }
});

const sizeClass = computed(() => {
    if (props.variant === 'playback') return '';
    if (props.size !== 'sm') return '';
    switch (props.variant) {
        case 'admin':
            return 'py-1.5 px-2.5 text-xs min-h-[2.125rem]';
        default:
            return 'py-1.5 pl-2.5 text-xs min-h-[2.25rem]';
    }
});

const paddingForChevron = computed(() =>
    props.size === 'sm' && props.variant === 'field' ? ' pr-8' : props.variant === 'field' ? ' pr-9' : '',
);

const selectClasses = computed(() => {
    let base = '';
    switch (props.variant) {
        case 'playback':
            base = 'playback-slot-select w-full min-w-0';
            break;
        case 'admin':
            base =
                'w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 outline-none transition-colors ' +
                'focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500';
            break;
        default:
            base =
                `input w-full cursor-pointer appearance-none py-2 pl-3 text-sm${paddingForChevron.value} ` +
                'focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20';
            break;
    }
    const parts = [base, invalidClass.value, sizeClass.value, props.selectClass].filter(Boolean);
    return parts.join(' ').trim();
});

const wrapperClasses = computed(() => {
    const parts = ['relative w-full'];
    if (props.variant === 'field') parts.push('rounded-lg');
    if (props.wrapperClass) parts.push(props.wrapperClass);
    return parts.join(' ');
});

const showChevron = () => props.variant === 'field' && !props.hideChevron;

const chevronWrapClass = computed(() => {
    const pad = props.size === 'sm' ? ' pr-2' : ' pr-3';
    return `pointer-events-none absolute inset-y-0 right-0 flex items-center text-zinc-500 dark:text-zinc-400${pad}`;
});

const chevronSvgClass = computed(() =>
    props.size === 'sm' ? 'h-3.5 w-3.5 shrink-0' : 'h-4 w-4 shrink-0',
);

function onChange(e: Event) {
    const el = e.target as HTMLSelectElement;
    emit('update:modelValue', coerceFromDom(el.value));
    emit('change', e);
}
</script>

<template>
    <FormSelectListbox v-if="useListbox" v-bind="listboxBindings" @update:model-value="onListboxChange">
        <template #chevron>
            <slot name="chevron">
                <svg
                    :class="chevronSvgClass"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </slot>
        </template>
    </FormSelectListbox>

    <div v-else :class="wrapperClasses">
        <select
            :id="id"
            class="[&::-ms-expand]:hidden"
            :class="selectClasses"
            :value="domString(modelValue)"
            :disabled="disabled"
            :name="name"
            :autocomplete="autocomplete"
            :aria-label="ariaLabel"
            :aria-invalid="invalid || undefined"
            @change="onChange"
        >
            <option
                v-if="placeholder !== undefined"
                value=""
                :disabled="placeholderDisabled"
            >
                {{ placeholder }}
            </option>
            <option
                v-for="opt in options"
                :key="`${String(opt.value)}-${opt.label}`"
                :value="String(opt.value)"
                :disabled="opt.disabled"
            >
                {{ opt.label }}
            </option>
        </select>
        <span
            v-if="showChevron()"
            :class="chevronWrapClass"
            aria-hidden="true"
        >
            <slot name="chevron">
                <svg
                    :class="chevronSvgClass"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    stroke-width="2"
                >
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
            </slot>
        </span>
    </div>
</template>
