<script setup lang="ts">
/**
 * Accessible custom list panel (no native `<option>` picker). Used by FormSelect when
 * `presentation` resolves to `"custom"` — styling matches app theme.
 */
import { computed, ref, watch, nextTick, onMounted, onUnmounted, useId } from 'vue';

export type SelectOption = {
    value: string | number;
    label: string;
    disabled?: boolean;
};

type Model = string | number | null | undefined;

type FlatRow = {
    key: string;
    value: string;
    label: string;
    disabled: boolean;
    isPlaceholder: boolean;
};

const props = withDefaults(
    defineProps<{
        options: SelectOption[];
        modelValue?: Model;
        placeholder?: string;
        placeholderDisabled?: boolean;
        numeric?: boolean;
        id?: string;
        disabled?: boolean;
        name?: string;
        ariaLabel?: string;
        variant?: 'field' | 'playback' | 'admin';
        selectClass?: string;
        wrapperClass?: string;
        size?: 'sm' | 'md';
        invalid?: boolean;
        hideChevron?: boolean;
    }>(),
    {
        modelValue: undefined,
        placeholderDisabled: true,
        numeric: false,
        variant: 'field',
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

function domString(value: Model): string {
    if (value === null || value === undefined) return '';
    return String(value);
}

function coerceEmit(raw: string): string | number {
    if (props.numeric && raw !== '') {
        const n = Number(raw);
        if (!Number.isNaN(n)) return n;
    }
    return raw;
}

const uid = useId();
const listboxId = `fs-lb-${uid}`;
const triggerUid = `${uid}-trigger`;

const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const open = ref(false);

const highlightedIndex = ref(0);

const invalidClass = computed(() => {
    if (!props.invalid) return '';
    switch (props.variant) {
        case 'playback':
            return 'border-red-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500/40 dark:border-red-500';
        case 'admin':
            return 'border-red-500 focus:border-red-500 focus:outline-none focus:ring-1 focus:ring-red-500/40';
        default:
            return 'border-red-500 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/25 dark:border-red-500/60 dark:focus:ring-red-500/30';
    }
});

const sizeClass = computed(() => {
    if (props.variant === 'playback') return '';
    if (props.size !== 'sm') return '';
    switch (props.variant) {
        case 'admin':
            return 'py-1.5 pl-2.5 pr-8 text-xs min-h-[2.125rem]';
        default:
            return 'py-1.5 pl-2.5 text-xs min-h-[2.25rem]';
    }
});

const paddingForChevron = computed(() =>
    props.size === 'sm' && props.variant === 'field' ? ' pr-8' : props.variant === 'field' ? ' pr-9' : '',
);

const triggerClasses = computed(() => {
    let base = '';
    switch (props.variant) {
        case 'playback':
            base =
                'playback-slot-select w-full min-w-0 inline-flex items-center gap-2 text-left ' +
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/35 dark:focus-visible:ring-sky-400/35';
            break;
        case 'admin':
            base =
                'relative block w-full rounded-md border border-slate-700 bg-slate-800 py-2 pl-3 pr-9 text-left text-sm text-slate-100 outline-none transition-colors ' +
                'focus-visible:border-slate-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-slate-500 disabled:opacity-50';
            break;
        default:
            base =
                `input relative block w-full cursor-pointer appearance-none py-2 pl-3 text-sm text-left${paddingForChevron.value} ` +
                'focus:outline-none focus-visible:border-sky-500 focus-visible:ring-2 focus-visible:ring-sky-500/20 disabled:cursor-not-allowed disabled:opacity-50';
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

const showChevron = computed(() => {
    if (props.variant === 'playback') return false;
    if (props.variant === 'field' && props.hideChevron) return false;
    return true;
});

const chevronWrapClass = computed(() => {
    const pad = props.size === 'sm' ? ' pr-2' : ' pr-3';
    return `pointer-events-none absolute inset-y-0 right-0 flex items-center text-slate-500 dark:text-slate-400${pad}`;
});

const chevronSvgClass = computed(() =>
    props.size === 'sm' ? 'h-3.5 w-3.5 shrink-0' : 'h-4 w-4 shrink-0',
);

const panelPadding = computed(() => (props.variant === 'playback' ? 'py-1' : 'py-1'));
const panelOptionPadding = computed(() =>
    props.variant === 'playback' ? 'px-2 py-1.5 text-xs' : props.size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-3 py-2 text-sm',
);

const panelClasses = computed(() => {
    const common =
        `${panelPadding.value} rounded-lg border shadow-lg outline-none ` +
        'ring-1 ring-slate-900/10 dark:ring-white/10 ';
    switch (props.variant) {
        case 'admin':
            return (
                `${common}` +
                'border-slate-600 bg-slate-950 text-slate-100 backdrop-blur-sm'
            );
        case 'playback':
            return (
                `${common}` +
                'border-slate-300 bg-white text-slate-900 shadow-md dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100'
            );
        default:
            return (
                `${common}` +
                'border-slate-200 bg-white text-slate-900 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-100'
            );
    }
});

const rows = computed<FlatRow[]>(() => {
    const out: FlatRow[] = [];
    if (props.placeholder !== undefined) {
        out.push({
            key: 'placeholder',
            value: '',
            label: props.placeholder,
            disabled: props.placeholderDisabled,
            isPlaceholder: true,
        });
    }
    for (const opt of props.options) {
        out.push({
            key: `${String(opt.value)}:${opt.label}`,
            value: String(opt.value),
            label: opt.label,
            disabled: !!opt.disabled,
            isPlaceholder: false,
        });
    }
    return out;
});

const selectedMatchIndex = computed(() =>
    rows.value.findIndex((r) => domString(props.modelValue) === r.value),
);

function firstHighlightedOnOpen(): number {
    const sel = rows.value.findIndex((r) => domString(props.modelValue) === r.value && !r.disabled);
    if (sel >= 0) return sel;
    const fs = rows.value.findIndex((r) => !r.disabled);
    return fs >= 0 ? fs : 0;
}

function optionId(i: number) {
    return `${listboxId}-opt-${i}`;
}

function selectedLabel(): string {
    const current = domString(props.modelValue);
    const match = rows.value.find((r) => r.value === current);
    return match?.label ?? rows.value.find((r) => r.key === 'placeholder')?.label ?? '';
}

const panelStyle = ref<Record<string, string>>({});

async function syncPanelPosition() {
    await nextTick();
    const tr = triggerRef.value;
    if (!tr || !open.value) return;
    const r = tr.getBoundingClientRect();
    const gap = props.variant === 'playback' ? 2 : 4;
    panelStyle.value = {
        position: 'fixed',
        top: `${Math.round(r.bottom + gap)}px`,
        left: `${Math.round(r.left)}px`,
        width: `${Math.round(r.width)}px`,
        zIndex: '60',
        minWidth: `${Math.round(r.width)}px`,
    };
}

function repositionLoop() {
    syncPanelPosition();
}

function toggle() {
    if (props.disabled) return;
    open.value = !open.value;
}

function close() {
    open.value = false;
}

function selectIndex(i: number) {
    const r = rows.value[i];
    if (!r || r.disabled) return;
    emit('update:modelValue', coerceEmit(r.value));
    emit('change', new Event('change', { bubbles: true }));
    close();
    triggerRef.value?.focus();
}

function clampHighlight(move: number) {
    const list = rows.value;
    const len = list.length;
    if (len === 0) return;
    let i = highlightedIndex.value;
    for (let step = 0; step <= len + 2; step++) {
        i = (i + move + len) % len;
        if (!list[i]!.disabled) {
            highlightedIndex.value = i;
            return;
        }
    }
}

function onTriggerKeydown(e: KeyboardEvent) {
    const list = rows.value;
    if (props.disabled || list.length === 0) return;

    switch (e.key) {
        case 'ArrowDown': {
            e.preventDefault();
            if (!open.value) {
                open.value = true;
                highlightedIndex.value = firstHighlightedOnOpen();
                void syncPanelPosition();
                return;
            }
            clampHighlight(1);
            scrollActiveIntoView();
            break;
        }
        case 'ArrowUp': {
            e.preventDefault();
            if (!open.value) {
                open.value = true;
                highlightedIndex.value = firstHighlightedOnOpen();
                void syncPanelPosition();
                return;
            }
            clampHighlight(-1);
            scrollActiveIntoView();
            break;
        }
        case 'Enter':
        case ' ': {
            e.preventDefault();
            if (!open.value) {
                open.value = true;
                highlightedIndex.value = firstHighlightedOnOpen();
                void syncPanelPosition();
                return;
            }
            selectIndex(highlightedIndex.value);
            break;
        }
        case 'Escape': {
            e.preventDefault();
            close();
            break;
        }
        case 'Tab':
            close();
            break;
        default:
            break;
    }
}

function scrollActiveIntoView() {
    requestAnimationFrame(() => {
        const el = panelRef.value?.querySelector(`#${CSS.escape(optionId(highlightedIndex.value))}`);
        el?.scrollIntoView({ block: 'nearest' });
    });
}

function onDocumentMouseDown(ev: MouseEvent) {
    if (!open.value) return;
    const t = ev.target instanceof Node ? ev.target : null;
    const tr = triggerRef.value?.contains(t ?? null);
    const pan = panelRef.value?.contains(t ?? null);
    if (!tr && !pan) close();
}

watch(open, (v, _pv) => {
    if (v) {
        highlightedIndex.value = firstHighlightedOnOpen();
        document.addEventListener('mousedown', onDocumentMouseDown, true);
        document.addEventListener('scroll', repositionLoop, true);
        window.addEventListener('resize', repositionLoop);
        void syncPanelPosition();
    } else {
        document.removeEventListener('mousedown', onDocumentMouseDown, true);
        document.removeEventListener('scroll', repositionLoop, true);
        window.removeEventListener('resize', repositionLoop);
    }
});

watch(
    () => [props.modelValue, rows.value.map((r) => r.key).join('|')] as const,
    () => {
        const i = selectedMatchIndex.value;
        if (i >= 0 && !rows.value[i]!.disabled) {
            highlightedIndex.value = i;
        } else if (!open.value) {
            highlightedIndex.value = firstHighlightedOnOpen();
        }
    },
);

watch(
    () => rows.value.length,
    () => {
        if (highlightedIndex.value >= rows.value.length) {
            highlightedIndex.value = Math.max(0, rows.value.length - 1);
        }
    },
);

onMounted(() => {
    highlightedIndex.value = firstHighlightedOnOpen();
});

onUnmounted(() => {
    document.removeEventListener('mousedown', onDocumentMouseDown, true);
    document.removeEventListener('scroll', repositionLoop, true);
    window.removeEventListener('resize', repositionLoop);
});

function rowVisualClass(idx: number, r: FlatRow) {
    const selected = domString(props.modelValue) === r.value;
    const hi = idx === highlightedIndex.value;
    const playback = props.variant === 'playback';
    const base = `${panelOptionPadding.value} flex cursor-pointer items-center justify-between gap-2`;
    let tone = '';
    if (r.disabled) {
        tone = ' cursor-not-allowed opacity-40';
    } else if (selected) {
        tone = playback
            ? ' bg-sky-500/15 text-slate-900 dark:bg-sky-500/20 dark:text-slate-100'
            : ' bg-slate-50 text-slate-900 dark:bg-slate-950/50 dark:text-slate-100';
    } else if (hi) {
        tone = ' bg-slate-100 text-slate-900 dark:bg-slate-800 dark:text-slate-100';
    } else {
        tone = ' text-slate-800 dark:text-slate-200';
    }
    return `${base}${tone}`;
}
</script>

<template>
    <div :class="wrapperClasses">
        <button
            :id="id ?? triggerUid"
            ref="triggerRef"
            type="button"
            class="w-full"
            :class="triggerClasses"
            role="combobox"
            :aria-expanded="open"
            :aria-controls="listboxId"
            :aria-activedescendant="open ? optionId(highlightedIndex) : undefined"
            :aria-label="ariaLabel"
            aria-haspopup="listbox"
            :aria-invalid="invalid || undefined"
            :disabled="disabled"
            :name="name"
            data-form-select-trigger
            @click="toggle"
            @keydown="onTriggerKeydown"
        >
            <span class="block min-w-0 truncate text-left">{{ selectedLabel() }}</span>
            <span v-if="showChevron" :class="chevronWrapClass" aria-hidden="true">
                <slot name="chevron">
                    <svg :class="chevronSvgClass" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                </slot>
            </span>
        </button>

        <Teleport to="body">
            <transition
                enter-active-class="transition duration-100 ease-out"
                enter-from-class="opacity-0 translate-y-px scale-[0.99]"
                enter-to-class="opacity-100 translate-y-0 scale-100"
                leave-active-class="transition duration-75 ease-in"
                leave-from-class="opacity-100"
                leave-to-class="opacity-0"
            >
                <ul
                    v-show="open"
                    :id="listboxId"
                    ref="panelRef"
                    class="max-h-[min(15rem,calc(100vh-5rem))] overflow-y-auto overscroll-contain"
                    :class="panelClasses"
                    :style="panelStyle"
                    role="listbox"
                    tabindex="-1"
                    aria-label="Options"
                    @keydown.stop.escape="close"
                >
                    <li
                        v-for="(row, idx) in rows"
                        :id="optionId(idx)"
                        :key="row.key"
                        role="option"
                        :aria-selected="row.disabled ? 'false' : domString(modelValue) === row.value ? 'true' : 'false'"
                        :aria-disabled="row.disabled ? 'true' : 'false'"
                        :class="rowVisualClass(idx, row)"
                        @mouseenter="!row.disabled && (highlightedIndex = idx)"
                        @click="
                            !(row.disabled) && selectIndex(idx);
                        "
                    >
                        <span class="truncate">{{ row.label }}</span>
                        <svg
                            v-if="!row.disabled && domString(modelValue) === row.value"
                            class="h-4 w-4 shrink-0 text-slate-600 dark:text-slate-400"
                            aria-hidden="true"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                            stroke-width="2.5"
                        >
                            <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                    </li>
                </ul>
            </transition>
        </Teleport>
    </div>
</template>
