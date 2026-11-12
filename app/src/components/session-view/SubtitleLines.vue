<script setup lang="ts">
/**
 * One language's lines, in time order: what each says and when it shows. The
 * line chosen opens for its times, typed or taken from the playhead, and the one
 * playing is marked. All lines move together with Shift all.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { createSegmentId, parseTime, type Segment } from '../segment-editor';
import { shiftLines, shortTime } from './subtitles';
import { stepBetweenFields } from '../../utils/fieldWalk';

const props = defineProps<{
    /** The video's length; a line added at the playhead ends within it. */
    duration: number;
    getCurrentTime: () => number;
    onSeek?: (seconds: number) => void;
}>();

const lines = defineModel<Segment[]>({ required: true });

const sorted = computed(() => [...lines.value].sort((a, b) => a.inSec - b.inSec));
const span = computed(() => Math.max(props.duration, ...lines.value.map((l) => l.outSec), 1));
/** The line open for editing, shared with the timeline so a block picked there opens here. */
const selectedId = defineModel<string | null>('selected', { default: null });

/** The playhead, read a few times a second: the line under it is marked in the list. */
const now = ref(0);
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    timer = setInterval(() => (now.value = props.getCurrentTime()), 250);
});
onBeforeUnmount(() => clearInterval(timer));
const playingId = computed(
    () => sorted.value.find((l) => l.inSec <= now.value && now.value < l.outSec)?.id ?? null
);

function update(id: string, change: Partial<Segment>): void {
    lines.value = lines.value.map((l) => (l.id === id ? { ...l, ...change } : l));
}

const fields = ref<Record<string, HTMLTextAreaElement | null>>({});
const root = ref<HTMLElement | null>(null);

/** Up and Down walk the lines' words, as they walk the chapter titles. */
function onWordsKeydown(e: KeyboardEvent): void {
    stepBetweenFields(e, Array.from(root.value?.querySelectorAll<HTMLTextAreaElement>('.subtitle-words') ?? []));
}

const rows = ref<Record<string, HTMLElement | null>>({});

// A line picked on the timeline comes into view without taking the keyboard from it.
watch(selectedId, async (id) => {
    await nextTick();
    if (id) rows.value[id]?.scrollIntoView?.({ block: 'nearest' });
});

async function select(line: Segment, seek = true): Promise<void> {
    selectedId.value = line.id;
    if (seek) props.onSeek?.(line.inSec);
    await nextTick();
    fields.value[line.id]?.focus();
}

/** A line starting at the playhead, two seconds long or to the next line, ready for its words. */
async function addAtPlayhead(): Promise<void> {
    const at = Math.min(props.getCurrentTime(), Math.max(0, span.value - 0.5));
    const next = sorted.value.find((l) => l.inSec > at);
    const out = Math.min(at + 2, next ? next.inSec : span.value, span.value);
    const line: Segment = { id: createSegmentId(), inSec: at, outSec: out > at ? out : at + 0.5, label: '' };
    lines.value = [...lines.value, line];
    await select(line, false);
}

function remove(id: string): void {
    lines.value = lines.value.filter((l) => l.id !== id);
    if (selectedId.value === id) selectedId.value = null;
}

/** A typed time: kept only when it reads as a time and leaves the line a length. */
function setTime(line: Segment, edge: 'inSec' | 'outSec', text: string, input: HTMLInputElement): void {
    const t = parseTime(text);
    const inSec = edge === 'inSec' ? t : line.inSec;
    const outSec = edge === 'outSec' ? t : line.outSec;
    if (t === null || t < 0 || inSec! >= outSec!) {
        input.value = shortTime(line[edge]);
        return;
    }
    update(line.id, { [edge]: t });
}

function fromPlayhead(line: Segment, edge: 'inSec' | 'outSec'): void {
    const t = props.getCurrentTime();
    if (edge === 'inSec' ? t < line.outSec : t > line.inSec) update(line.id, { [edge]: t });
}

const shiftBy = ref(0.5);
function shift(direction: 1 | -1): void {
    const by = Math.abs(Number(shiftBy.value) || 0) * direction;
    if (by) lines.value = shiftLines(lines.value, by);
}

</script>

<template>
    <div ref="root" class="flex min-h-0 flex-1 flex-col" data-test="subtitleLines">
        <div class="flex shrink-0 flex-wrap items-center gap-2.5 pb-2">
            <span class="text-[13px] text-slate-500 dark:text-slate-400">
                {{ lines.length }} line{{ lines.length === 1 ? '' : 's' }}
                <template v-if="lines.length"> · up to {{ shortTime(sorted.at(-1)!.outSec) }}</template>
            </span>
            <div
                role="group"
                aria-label="Shift all lines"
                class="ml-auto flex h-8 items-center gap-1 rounded-lg border border-sky-200 bg-white pl-2.5 pr-1 text-[13px] text-slate-700 dark:border-sky-400/12 dark:bg-[#0c1222] dark:text-slate-300"
            >
                <span class="mr-1 font-medium">Shift all</span>
                <button
                    type="button"
                    class="h-6 w-6.5 rounded-md bg-slate-100 font-semibold text-slate-900 hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-700 dark:text-slate-100"
                    :aria-label="`Earlier by ${shiftBy} seconds`"
                    :disabled="!lines.length"
                    data-test="shiftEarlier"
                    @click="shift(-1)"
                >
                    −
                </button>
                <label class="flex items-center">
                    <span class="sr-only">Seconds to shift</span>
                    <input
                        v-model.number="shiftBy"
                        type="number"
                        min="0.1"
                        step="0.1"
                        class="h-6 w-12 border-0 bg-transparent text-center font-mono text-xs text-zinc-900 outline-none dark:text-slate-100"
                        data-test="shiftBy"
                    />
                    <span class="text-xs text-slate-500">s</span>
                </label>
                <button
                    type="button"
                    class="h-6 w-6.5 rounded-md bg-slate-100 font-semibold text-slate-900 hover:bg-slate-200 disabled:opacity-50 dark:bg-slate-700 dark:text-slate-100"
                    :aria-label="`Later by ${shiftBy} seconds`"
                    :disabled="!lines.length"
                    data-test="shiftLater"
                    @click="shift(1)"
                >
                    +
                </button>
            </div>
            <button
                type="button"
                class="h-8 rounded-lg border border-sky-600 bg-white px-3 text-[13px] font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-400 dark:bg-transparent dark:text-sky-300"
                data-test="addLine"
                @click="addAtPlayhead"
            >
                + Line at {{ shortTime(now) }}
            </button>
        </div>

        <div
            v-if="lines.length"
            class="grid shrink-0 grid-cols-[1.75rem_10rem_minmax(0,1fr)_2rem] gap-3 px-2 pb-2 text-xs font-semibold text-slate-500 dark:text-slate-400"
        >
            <span>#</span><span>Shows</span><span>Words</span><span></span>
        </div>
        <ol class="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0">
            <li
                v-for="(line, i) in sorted"
                :key="line.id"
                :ref="(el) => (rows[line.id] = el as HTMLElement | null)"
                class="grid grid-cols-[1.75rem_10rem_minmax(0,1fr)_2rem] items-start gap-3 rounded-lg px-2 py-2"
                :class="
                    line.id === selectedId || line.id === playingId
                        ? 'bg-sky-50 dark:bg-sky-400/10'
                        : ''
                "
                :aria-current="line.id === playingId ? 'true' : undefined"
                data-test="subtitleLine"
                @click="selectedId !== line.id && select(line)"
            >
                <span
                    class="pt-1.5 text-[13px]"
                    :class="line.id === playingId ? 'font-semibold text-sky-800 dark:text-sky-300' : 'text-slate-500'"
                    >{{ i + 1 }}</span
                >
                <span v-if="line.id !== selectedId" class="pt-1.5 font-mono text-[13px] text-slate-700 dark:text-slate-300">
                    {{ shortTime(line.inSec) }} – {{ shortTime(line.outSec) }}
                </span>
                <span v-else class="flex flex-col gap-1.5">
                    <span class="flex items-center gap-1">
                        <input
                            :value="shortTime(line.inSec)"
                            class="h-7.5 w-16 rounded-md border border-sky-300 bg-white px-1.5 font-mono text-[13px] text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/30 dark:bg-[#0c1222] dark:text-slate-100"
                            :aria-label="`Line ${i + 1} starts`"
                            data-test="lineStart"
                            @change="setTime(line, 'inSec', ($event.target as HTMLInputElement).value, $event.target as HTMLInputElement)"
                        />
                        <span class="text-slate-500">–</span>
                        <input
                            :value="shortTime(line.outSec)"
                            class="h-7.5 w-16 rounded-md border border-sky-300 bg-white px-1.5 font-mono text-[13px] text-zinc-900 outline-none focus:border-sky-600 dark:border-sky-400/30 dark:bg-[#0c1222] dark:text-slate-100"
                            :aria-label="`Line ${i + 1} ends`"
                            data-test="lineEnd"
                            @change="setTime(line, 'outSec', ($event.target as HTMLInputElement).value, $event.target as HTMLInputElement)"
                        />
                    </span>
                    <span class="flex gap-1.5">
                        <button
                            type="button"
                            class="h-6.5 rounded-md border border-sky-300 bg-white px-2 text-xs font-semibold text-sky-800 hover:bg-sky-50 dark:border-sky-400/30 dark:bg-transparent dark:text-sky-300"
                            data-test="startHere"
                            @click.stop="fromPlayhead(line, 'inSec')"
                        >
                            Start here
                        </button>
                        <button
                            type="button"
                            class="h-6.5 rounded-md border border-sky-300 bg-white px-2 text-xs font-semibold text-sky-800 hover:bg-sky-50 dark:border-sky-400/30 dark:bg-transparent dark:text-sky-300"
                            data-test="endHere"
                            @click.stop="fromPlayhead(line, 'outSec')"
                        >
                            End here
                        </button>
                    </span>
                </span>
                <textarea
                    :ref="(el) => (fields[line.id] = el as HTMLTextAreaElement | null)"
                    :value="line.label ?? ''"
                    :rows="line.id === selectedId ? 2 : 1"
                    class="subtitle-words w-full resize-none rounded-md border bg-white px-2.5 py-1.5 text-sm leading-snug text-zinc-900 outline-none dark:bg-[#0c1222] dark:text-slate-200"
                    :class="
                        line.id === selectedId
                            ? 'border-sky-600 dark:border-sky-400'
                            : 'border-slate-200 dark:border-slate-700'
                    "
                    :aria-label="`Line ${i + 1} words`"
                    placeholder="What is said"
                    data-test="lineWords"
                    @focus="selectedId = line.id"
                    @keydown="onWordsKeydown"
                    @input="update(line.id, { label: ($event.target as HTMLTextAreaElement).value })"
                ></textarea>
                <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-red-600 dark:hover:bg-slate-700"
                    :aria-label="`Remove line ${i + 1}`"
                    data-test="removeLine"
                    @click.stop="remove(line.id)"
                >
                    <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                        <path d="M6 6l12 12M18 6L6 18" />
                    </svg>
                </button>
            </li>
        </ol>
        <p v-if="!lines.length" class="m-0 py-8 text-center text-sm text-slate-500 dark:text-slate-400">
            No lines yet. Play to where something is said, then press + Line, or import a file from the options menu.
        </p>
    </div>
</template>
