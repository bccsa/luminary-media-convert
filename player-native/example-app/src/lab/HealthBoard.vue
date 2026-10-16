<script setup lang="ts">
/**
 * The small screen that answers one question: is anything broken, too slow, or not working? A
 * strip with the verdict and the worst problems; tap it for every check.
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import type { Check, HealthProbe, Verdict } from './probe';

const props = defineProps<{ probe: HealthProbe }>();
const emit = defineEmits<{ reset: [] }>();

const open = ref(false);
// The checks read plain samples; re-derive them on a steady beat rather than on every change.
const tick = ref(0);
const timer = setInterval(() => tick.value++, 500);
onBeforeUnmount(() => clearInterval(timer));

const checks = computed<Check[]>(() => (tick.value, props.probe.checks()));
const overall = computed<Verdict>(() => props.probe.overall(checks.value));
const problems = computed(() =>
    checks.value
        .filter((check) => check.verdict === 'broken' || check.verdict === 'slow')
        .sort((a, b) => (a.verdict === 'broken' ? -1 : 0) - (b.verdict === 'broken' ? -1 : 0)),
);

const HEADLINE: Record<Verdict, string> = {
    ok: 'All good',
    slow: 'Slow',
    broken: 'Broken',
    idle: 'Idle',
};
</script>

<template>
    <section class="board" :class="`board--${overall}`">
        <button class="board__strip" type="button" @click="open = !open">
            <span class="board__verdict">{{ HEADLINE[overall] }}</span>
            <span class="board__summary">
                <template v-if="problems.length">
                    <span v-for="check in problems.slice(0, 2)" :key="check.id" class="board__problem">
                        {{ check.label }}: {{ check.detail }}
                    </span>
                </template>
                <span v-else class="board__problem">{{ overall === 'idle' ? 'Play something to start measuring' : 'Nothing broken, nothing slow' }}</span>
            </span>
            <span class="board__chevron">{{ open ? '▾' : '▸' }}</span>
        </button>
        <div v-if="open" class="board__details">
            <div v-for="check in checks" :key="check.id" class="board__row">
                <span class="board__dot" :class="`board__dot--${check.verdict}`" />
                <span class="board__label">{{ check.label }}</span>
                <span class="board__detail">{{ check.detail }}</span>
            </div>
            <button class="capsule" type="button" @click="emit('reset')">Reset measurements</button>
        </div>
    </section>
</template>

<style scoped>
.board {
    position: sticky;
    bottom: 0;
    z-index: 10;
    margin: 0 -12px;
    color: #fff;
    background: #3a3a3c;
    box-shadow: 0 -2px 12px rgba(0, 0, 0, 0.2);
}
.board--ok {
    background: #248a3d;
}
.board--slow {
    background: #c93400;
}
.board--broken {
    background: #d70015;
}
.board__strip {
    all: unset;
    box-sizing: border-box;
    display: flex;
    gap: 12px;
    align-items: center;
    width: 100%;
    padding: 10px 14px calc(10px + env(safe-area-inset-bottom));
    cursor: pointer;
}
.board__verdict {
    font-weight: 700;
    font-size: 17px;
    white-space: nowrap;
}
.board__summary {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    font-size: 12px;
    opacity: 0.95;
}
.board__problem {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
.board__details {
    background: #fff;
    color: #000;
    padding: 8px 14px 14px;
    max-height: 50vh;
    overflow: auto;
}
.board__row {
    display: grid;
    grid-template-columns: 12px 130px 1fr;
    gap: 8px;
    align-items: baseline;
    padding: 5px 0;
    border-bottom: 1px solid #eee;
    font-size: 13px;
}
.board__detail {
    font: 12px ui-monospace, Menlo, monospace;
    color: #3c3c43;
    word-break: break-word;
}
.board__dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: #c7c7cc;
}
.board__dot--ok {
    background: #34c759;
}
.board__dot--slow {
    background: #ff9500;
}
.board__dot--broken {
    background: #ff3b30;
}
.board__details .capsule {
    margin-top: 10px;
}
</style>
