<script setup lang="ts">
/**
 * A translation beside its original, line by line in time order: what the
 * original says, and the translation's words to edit. A line of the original
 * no translation covers yet has an empty field; typing in it starts the
 * translation's line on the original's timing. A row's time plays from there,
 * and the row the player is in is marked.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { createSegmentId, type Segment } from '../segment-editor';
import { compareRows, shortTime, type CompareRow } from './subtitles';

const props = defineProps<{
    original: Segment[];
    translationName: string;
    getCurrentTime?: () => number;
    onSeek?: (seconds: number) => void;
}>();

const translation = defineModel<Segment[]>({ required: true });

const rows = computed(() => compareRows(props.original, translation.value));
const done = computed(() => rows.value.filter((row) => row.cue?.label?.trim()).length);

const now = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    if (props.getCurrentTime) timer = setInterval(() => (now.value = props.getCurrentTime!()), 250);
});
onBeforeUnmount(() => clearInterval(timer));
const playing = (row: CompareRow) => row.inSec <= now.value && now.value < row.outSec;

const fields = ref<HTMLTextAreaElement[]>([]);

function write(row: CompareRow, words: string): void {
    if (row.cue) {
        translation.value = translation.value.map((c) => (c.id === row.cue!.id ? { ...c, label: words } : c));
        return;
    }
    translation.value = [
        ...translation.value,
        { id: createSegmentId(), inSec: row.inSec, outSec: row.outSec, label: words },
    ];
}

/** The first row after the one being typed in (or from the top) that has no words yet. */
async function nextToTranslate(): Promise<void> {
    const focused = fields.value.findIndex((f) => f === document.activeElement);
    const order = rows.value.map((_, i) => i);
    const after = [...order.slice(focused + 1), ...order.slice(0, focused + 1)];
    const target = after.find((i) => !rows.value[i]!.cue?.label?.trim());
    if (target === undefined) return;
    props.onSeek?.(rows.value[target]!.inSec);
    await nextTick();
    fields.value[target]?.focus();
}
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col" data-test="subtitleCompare">
        <div class="flex shrink-0 items-center gap-3 border-b border-sky-100 pb-3 dark:border-sky-400/10">
            <div
                role="progressbar"
                aria-label="Lines translated"
                aria-valuemin="0"
                :aria-valuemax="rows.length"
                :aria-valuenow="done"
                class="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800"
            >
                <div
                    class="h-full rounded-full bg-sky-700 transition-[width] dark:bg-sky-400"
                    :style="{ width: rows.length ? `${(done / rows.length) * 100}%` : '0%' }"
                ></div>
            </div>
            <span class="text-[13px] font-medium text-slate-700 dark:text-slate-300" data-test="translatedCount">
                {{ done }} of {{ rows.length }} translated
            </span>
            <button
                type="button"
                class="chapter-toolbar-muted"
                :disabled="done === rows.length"
                data-test="nextToTranslate"
                @click="nextToTranslate"
            >
                Next to translate
            </button>
        </div>
        <ol class="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pt-1">
            <li
                v-for="(row, i) in rows"
                :key="`${row.inSec}-${row.outSec}-${i}`"
                class="grid grid-cols-[4rem_minmax(0,1fr)_minmax(0,1fr)] items-start gap-4 rounded-lg px-2 py-3"
                :class="playing(row) ? 'bg-sky-50 dark:bg-sky-400/10' : 'border-b border-slate-100 dark:border-slate-800'"
                :aria-current="playing(row) ? 'true' : undefined"
                data-test="subtitleCompareRow"
            >
                <button
                    type="button"
                    class="cursor-pointer pt-1.5 text-left font-mono text-[13px] text-sky-700 tabular-nums hover:underline dark:text-sky-300"
                    :class="{ 'font-semibold text-sky-900': playing(row) }"
                    :title="`Play from ${shortTime(row.inSec)}`"
                    @click="onSeek?.(row.inSec)"
                >
                    {{ shortTime(row.inSec) }}
                </button>
                <p
                    class="m-0 pt-1.5 text-sm leading-snug whitespace-pre-line text-slate-700 dark:text-slate-300"
                    :class="{ 'font-medium text-zinc-900 dark:text-slate-100': playing(row) }"
                >
                    {{ row.original || '—' }}
                </p>
                <textarea
                    ref="fields"
                    :value="row.cue?.label ?? ''"
                    rows="2"
                    placeholder="Translate this line"
                    class="w-full resize-y rounded-md px-2.5 py-1.5 text-sm leading-snug text-zinc-900 outline-none focus:border-solid focus:border-sky-600 dark:text-slate-200 dark:focus:border-sky-400"
                    :class="
                        row.cue?.label?.trim()
                            ? 'border border-slate-200 bg-white dark:border-slate-700 dark:bg-[#0c1222]'
                            : 'border border-dashed border-slate-400 bg-slate-50 dark:border-slate-600 dark:bg-[#0c1222]'
                    "
                    :aria-label="`${translationName} at ${shortTime(row.inSec)}`"
                    data-test="subtitleCompareWords"
                    @input="write(row, ($event.target as HTMLTextAreaElement).value)"
                ></textarea>
            </li>
        </ol>
        <p v-if="rows.length === 0" class="m-0 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Neither language has lines yet.
        </p>
    </div>
</template>
