<script setup lang="ts">
/**
 * The form's dropdown: a trigger styled as `ecf-select` and a themed list panel,
 * with an optional search field.
 *
 * Every select in the form goes through this, so they look and behave alike.
 * The panel is ordinary DOM teleported to `<body>` and rendered only while open —
 * never a `<datalist>`, whose Electron popup is drawn in the main process with
 * no scrolling and froze the app on a long list.
 *
 * Arrow up/down on the closed trigger are left to the host, so the track table's
 * grid navigation keeps working. Enter, Space or Alt+ArrowDown opens it; on a
 * searchable menu a typed letter opens it too and starts the search.
 */
import {
    computed,
    nextTick,
    onBeforeUnmount,
    ref,
    useAttrs,
    useId,
    watch,
} from 'vue';

export type SelectMenuOption = {
    value: string | number;
    label: string;
    /** Short monospace column ahead of the label (a language code). */
    code?: string;
    disabled?: boolean;
};

defineOptions({ inheritAttrs: false });

const props = withDefaults(
    defineProps<{
        modelValue?: string | number | null;
        options: readonly SelectMenuOption[];
        placeholder?: string;
        disabled?: boolean;
        ariaLabel?: string;
        invalid?: boolean;
        /** Trigger tooltip; defaults to the selected label. */
        title?: string;
        /** What the closed trigger shows for the selected option; defaults to its label. */
        displayValue?: string;
        searchable?: boolean;
        searchPlaceholder?: string;
        /** Replaces the default label/code substring match. */
        filter?: (query: string) => readonly SelectMenuOption[];
        noMatchText?: string;
    }>(),
    {
        modelValue: undefined,
        placeholder: '',
        disabled: false,
        ariaLabel: undefined,
        invalid: false,
        title: undefined,
        displayValue: undefined,
        searchable: false,
        searchPlaceholder: 'Search',
        filter: undefined,
        noMatchText: 'No matches',
    },
);

const emit = defineEmits<{
    'update:modelValue': [value: string | number];
    change: [value: string | number];
}>();

const attrs = useAttrs();

const uid = useId();
const listboxId = `ecf-menu-${uid}`;

const triggerRef = ref<HTMLButtonElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const listRef = ref<HTMLElement | null>(null);

const open = ref(false);
const query = ref('');
const highlighted = ref(0);
const panelStyle = ref<Record<string, string>>({});

const selected = computed(() =>
    props.options.find((o) => o.value === props.modelValue),
);

const triggerText = computed(
    () => props.displayValue ?? selected.value?.label ?? '',
);

const triggerTitle = computed(() => props.title ?? selected.value?.label);

const rows = computed<readonly SelectMenuOption[]>(() => {
    const q = query.value.trim().toLowerCase();
    if (!props.searchable || q === '') return props.options;
    if (props.filter) return props.filter(q);
    return props.options.filter(
        (o) =>
            o.label.toLowerCase().includes(q)
            || (o.code?.toLowerCase().includes(q) ?? false),
    );
});

function optionId(i: number): string {
    return `${listboxId}-opt-${i}`;
}

function isSelected(option: SelectMenuOption): boolean {
    return option.value === props.modelValue;
}

function firstEnabledFrom(start: number, step: 1 | -1): number {
    const list = rows.value;
    for (let i = start; i >= 0 && i < list.length; i += step) {
        if (!list[i]!.disabled) return i;
    }
    return -1;
}

function positionPanel(): void {
    const tr = triggerRef.value;
    if (!tr) return;
    const r = tr.getBoundingClientRect();
    const gap = 4;
    const margin = 8;
    const below = window.innerHeight - r.bottom - gap - margin;
    const above = r.top - gap - margin;
    const flip = below < 200 && above > below;
    const maxHeight = Math.min(320, Math.max(flip ? above : below, 160));

    // One edge always sits flush with the trigger: the left edge when there
    // is room beside it, otherwise the right edge, growing leftwards.
    const wanted = props.searchable ? 256 : 0;
    const floor = Math.max(r.width, props.searchable ? 200 : r.width);
    const roomRight = window.innerWidth - r.left - margin;
    const alignRight = roomRight < floor;
    const room = alignRight ? r.right - margin : roomRight;

    const style: Record<string, string> = {
        position: 'fixed',
        minWidth: `${r.width}px`,
        maxWidth: `${Math.max(room, r.width)}px`,
        maxHeight: `${maxHeight}px`,
        zIndex: '60',
    };
    style.width = props.searchable
        ? `${Math.max(r.width, Math.min(wanted, room))}px`
        : 'max-content';
    if (alignRight) style.right = `${window.innerWidth - r.right}px`;
    else style.left = `${r.left}px`;
    if (flip) style.bottom = `${window.innerHeight - r.top + gap}px`;
    else style.top = `${r.bottom + gap}px`;
    panelStyle.value = style;
}

async function openPanel(initialQuery = ''): Promise<void> {
    if (props.disabled) return;
    query.value = initialQuery;
    open.value = true;
    const current = rows.value.findIndex(isSelected);
    highlighted.value =
        !initialQuery && current >= 0 ? current : Math.max(firstEnabledFrom(0, 1), 0);
    positionPanel();
    await nextTick();
    if (props.searchable) searchRef.value?.focus();
    scrollHighlightedIntoView();
}

function closePanel(refocus: boolean): void {
    if (!open.value) return;
    open.value = false;
    query.value = '';
    if (refocus) triggerRef.value?.focus();
}

function choose(i: number): void {
    const option = rows.value[i];
    if (!option || option.disabled) return;
    const changed = option.value !== props.modelValue;
    emit('update:modelValue', option.value);
    if (changed) emit('change', option.value);
    closePanel(true);
}

function move(delta: number): void {
    const len = rows.value.length;
    if (len === 0) return;
    const target = Math.min(Math.max(highlighted.value + delta, 0), len - 1);
    const step = delta > 0 ? 1 : -1;
    const next =
        firstEnabledFrom(target, step) >= 0
            ? firstEnabledFrom(target, step)
            : firstEnabledFrom(target, step === 1 ? -1 : 1);
    if (next >= 0) highlighted.value = next;
    scrollHighlightedIntoView();
}

function scrollHighlightedIntoView(): void {
    void nextTick(() => {
        document
            .getElementById(optionId(highlighted.value))
            ?.scrollIntoView?.({ block: 'nearest' });
    });
}

/** Keys while the list is open, from the search field or the trigger. */
function onOpenKeydown(e: KeyboardEvent): void {
    switch (e.key) {
        case 'ArrowDown':
            e.preventDefault();
            move(1);
            break;
        case 'ArrowUp':
            e.preventDefault();
            move(-1);
            break;
        case 'PageDown':
            e.preventDefault();
            move(8);
            break;
        case 'PageUp':
            e.preventDefault();
            move(-8);
            break;
        case 'Home':
            if (props.searchable) break;
            e.preventDefault();
            move(-rows.value.length);
            break;
        case 'End':
            if (props.searchable) break;
            e.preventDefault();
            move(rows.value.length);
            break;
        case 'Enter':
        case ' ':
            if (e.key === ' ' && props.searchable) break;
            e.preventDefault();
            choose(highlighted.value);
            break;
        case 'Escape':
            e.preventDefault();
            e.stopPropagation();
            closePanel(true);
            break;
        case 'Tab':
            // The panel lives at the end of <body>; tabbing out of it would
            // land nowhere near the table.
            e.preventDefault();
            closePanel(true);
            break;
    }
}

function onTriggerKeydown(e: KeyboardEvent): void {
    if (props.disabled) return;
    if (open.value) {
        onOpenKeydown(e);
        return;
    }
    if (
        e.key === 'Enter'
        || e.key === ' '
        || (e.key === 'ArrowDown' && e.altKey)
    ) {
        e.preventDefault();
        void openPanel();
    } else if (
        props.searchable
        && e.key.length === 1
        && /[a-z0-9]/i.test(e.key)
        && !e.metaKey
        && !e.ctrlKey
        && !e.altKey
    ) {
        e.preventDefault();
        void openPanel(e.key.toLowerCase());
    }
}

watch(query, () => {
    highlighted.value = Math.max(firstEnabledFrom(0, 1), 0);
    if (listRef.value) listRef.value.scrollTop = 0;
});

function onDocumentPointerDown(ev: Event): void {
    const t = ev.target instanceof Node ? ev.target : null;
    if (triggerRef.value?.contains(t) || panelRef.value?.contains(t)) return;
    closePanel(false);
}

function onScroll(ev: Event): void {
    // The list scrolling itself is not the page moving under the trigger.
    if (ev.target instanceof Node && panelRef.value?.contains(ev.target)) return;
    positionPanel();
}

function stopListening(): void {
    document.removeEventListener('mousedown', onDocumentPointerDown, true);
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', positionPanel);
}

watch(open, (isOpen) => {
    if (isOpen) {
        document.addEventListener('mousedown', onDocumentPointerDown, true);
        document.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', positionPanel);
    } else {
        stopListening();
    }
});

onBeforeUnmount(stopListening);
</script>

<template>
    <!-- attrs last, so this trigger's own keydown runs before the host's. -->
    <button
        ref="triggerRef"
        type="button"
        class="ecf-select ecf-menu-trigger"
        :class="{ 'ecf-input-invalid': invalid }"
        role="combobox"
        aria-haspopup="listbox"
        :aria-expanded="open"
        :aria-controls="listboxId"
        :aria-activedescendant="
            open && !searchable && rows.length
                ? optionId(highlighted)
                : undefined
        "
        :aria-label="ariaLabel"
        :aria-invalid="invalid || undefined"
        :title="triggerTitle"
        :disabled="disabled"
        data-select-menu
        @click="open ? closePanel(true) : openPanel()"
        @keydown="onTriggerKeydown"
        v-bind="attrs"
    >
        <span v-if="triggerText" class="ecf-menu-value">{{ triggerText }}</span>
        <span v-else class="ecf-menu-placeholder">{{ placeholder }}</span>
    </button>

    <Teleport to="body">
        <div
            v-if="open"
            ref="panelRef"
            class="ecf-menu-panel"
            :style="panelStyle"
        >
            <div v-if="searchable" class="ecf-menu-search-wrap">
                <svg
                    class="ecf-menu-search-icon"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.75"
                    aria-hidden="true"
                >
                    <circle cx="9" cy="9" r="5.5" />
                    <path stroke-linecap="round" d="M13.2 13.2 17 17" />
                </svg>
                <input
                    ref="searchRef"
                    v-model="query"
                    type="text"
                    class="ecf-menu-search"
                    :placeholder="searchPlaceholder"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    role="searchbox"
                    :aria-controls="listboxId"
                    :aria-activedescendant="
                        rows.length ? optionId(highlighted) : undefined
                    "
                    data-menu-search
                    @keydown="onOpenKeydown"
                />
            </div>
            <ul
                :id="listboxId"
                ref="listRef"
                class="ecf-menu-list"
                role="listbox"
                :aria-label="ariaLabel"
            >
                <li
                    v-for="(option, i) in rows"
                    :id="optionId(i)"
                    :key="String(option.value)"
                    role="option"
                    class="ecf-menu-option"
                    :class="{
                        'ecf-menu-option--active': i === highlighted,
                        'ecf-menu-option--selected': isSelected(option),
                        'ecf-menu-option--disabled': option.disabled,
                    }"
                    :aria-selected="isSelected(option)"
                    :aria-disabled="option.disabled || undefined"
                    @mouseenter="!option.disabled && (highlighted = i)"
                    @mousedown.prevent
                    @click="choose(i)"
                >
                    <span v-if="option.code !== undefined" class="ecf-menu-code">{{
                        option.code || '—'
                    }}</span>
                    <span class="ecf-menu-label">{{ option.label }}</span>
                    <svg
                        v-if="isSelected(option)"
                        class="ecf-menu-check"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2.5"
                        aria-hidden="true"
                    >
                        <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            d="M5 13l4 4L19 7"
                        />
                    </svg>
                </li>
                <li v-if="rows.length === 0" class="ecf-menu-empty">
                    {{ noMatchText }}
                </li>
            </ul>
        </div>
    </Teleport>
</template>
