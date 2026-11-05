<script setup lang="ts">
/**
 * A translation beside its original, line by line in time order: what the
 * original says on the left, the translation's words on the right to edit.
 * Where the original says something no translation cue covers yet, its row
 * offers to start one on the original's timing. A row's time seeks the player.
 */
import { computed, nextTick, ref } from 'vue';
import { createSegmentId, formatTime, type Segment } from '../segment-editor';
import { compareRows, type CompareRow } from './subtitles';

const props = defineProps<{
    original: Segment[];
    originalName: string;
    translationName: string;
    onSeek?: (seconds: number) => void;
}>();

const translation = defineModel<Segment[]>({ required: true });

const rows = computed(() => compareRows(props.original, translation.value));

const fields = ref<Record<string, HTMLTextAreaElement | null>>({});

function setWords(cue: Segment, words: string): void {
    translation.value = translation.value.map((c) => (c.id === cue.id ? { ...c, label: words } : c));
}

/** A cue on the original's timing for a row the translation does not cover; its field takes the focus. */
async function translateRow(row: CompareRow): Promise<void> {
    const cue: Segment = { id: createSegmentId(), inSec: row.inSec, outSec: row.outSec, label: '' };
    translation.value = [...translation.value, cue];
    await nextTick();
    fields.value[cue.id]?.focus();
}

const untranslated = computed(() => rows.value.filter((row) => !row.cue?.label?.trim()).length);
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col" data-test="subtitleCompare">
        <div
            class="grid shrink-0 grid-cols-[4.5rem_1fr_1fr] gap-3 border-b border-sky-200 pb-1.5 text-xs font-semibold text-slate-500 dark:border-sky-400/12 dark:text-slate-400"
        >
            <span>Time</span>
            <span class="truncate">{{ originalName }}</span>
            <span class="truncate">
                {{ translationName }}
                <span v-if="untranslated > 0" class="font-normal">· {{ untranslated }} to translate</span>
            </span>
        </div>
        <ol class="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
            <li
                v-for="(row, i) in rows"
                :key="row.cue?.id ?? `o${i}`"
                class="grid grid-cols-[4.5rem_1fr_1fr] items-start gap-3 border-b border-sky-100 py-2 last:border-b-0 dark:border-sky-400/8"
                data-test="subtitleCompareRow"
            >
                <button
                    type="button"
                    class="cursor-pointer text-left font-mono text-xs text-sky-700 tabular-nums hover:underline dark:text-sky-300"
                    :title="`Play from ${formatTime(row.inSec)}`"
                    @click="onSeek?.(row.inSec)"
                >
                    {{ formatTime(row.inSec) }}
                </button>
                <p class="m-0 text-sm whitespace-pre-line text-slate-600 dark:text-slate-300">
                    {{ row.original || '—' }}
                </p>
                <textarea
                    v-if="row.cue"
                    :ref="(el) => (fields[row.cue!.id] = el as HTMLTextAreaElement | null)"
                    :value="row.cue.label ?? ''"
                    rows="2"
                    class="w-full resize-y rounded-md border border-sky-200 bg-white px-2 py-1 text-sm text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-200 dark:focus:border-sky-400"
                    :aria-label="`${translationName} at ${formatTime(row.inSec)}`"
                    data-test="subtitleCompareWords"
                    @input="setWords(row.cue!, ($event.target as HTMLTextAreaElement).value)"
                />
                <button
                    v-else
                    type="button"
                    class="chapter-toolbar-muted justify-self-start"
                    data-test="subtitleCompareTranslate"
                    @click="translateRow(row)"
                >
                    + Translate this line
                </button>
            </li>
        </ol>
        <p v-if="rows.length === 0" class="m-0 py-6 text-center text-sm text-slate-500 dark:text-slate-400">
            Neither language has lines yet.
        </p>
    </div>
</template>
