<script setup lang="ts">
import { reactive, ref, shallowRef } from 'vue';
import { INTENSITIES, SCENARIOS, runScenario, type Intensity, type ScenarioResult, type StressContext } from './stress';

const props = defineProps<{
    /** A context for one run; the panel supplies the intensity, abort signal and progress. */
    context: (intensity: Intensity, signal: AbortSignal, progress: (fraction: number) => void) => StressContext;
}>();

const intensity = ref<Intensity>(INTENSITIES[1]!);
const results = reactive<Record<string, ScenarioResult>>({});
const running = ref<string | null>(null);
const progress = ref(0);
const abort = shallowRef<AbortController | null>(null);

async function run(ids: string[], chosen = intensity.value): Promise<void> {
    if (running.value) return;
    const controller = new AbortController();
    abort.value = controller;
    try {
        for (const id of ids) {
            if (controller.signal.aborted) break;
            const scenario = SCENARIOS.find((s) => s.id === id)!;
            running.value = id;
            progress.value = 0;
            results[id] = await runScenario(scenario, props.context(chosen, controller.signal, (f) => (progress.value = f)));
        }
    } finally {
        running.value = null;
        abort.value = null;
    }
}

/** One quick burst of the short scenarios, for a fast "is anything off" pass. */
function burst(): void {
    void run(['play-pause', 'seek-storm', 'quality-hop', 'audio-hop', 'angle-hop'], INTENSITIES[1]!);
}

const ICON: Record<ScenarioResult['status'], string> = { pass: '●', slow: '●', fail: '●', skipped: '○' };
</script>

<template>
    <section class="panel">
        <header class="panel__head">
            <h2>Stress</h2>
            <div class="segmented segmented--small">
                <button
                    v-for="option in INTENSITIES"
                    :key="option.id"
                    type="button"
                    :class="{ selected: option.id === intensity.id }"
                    :disabled="!!running"
                    @click="intensity = option"
                >
                    {{ option.label }}
                </button>
            </div>
        </header>
        <p class="panel__hint">
            {{ intensity.iterations }} actions, {{ intensity.intervalMs }} ms apart · soak {{ intensity.soakSeconds }} s
        </p>
        <div class="panel__actions">
            <button class="capsule capsule--prominent" type="button" :disabled="!!running" @click="run(SCENARIOS.map((s) => s.id))">Run all</button>
            <button class="capsule" type="button" :disabled="!!running" @click="burst">Rapid burst</button>
            <button class="capsule" type="button" :disabled="!running" @click="abort?.abort()">Stop</button>
        </div>
        <div v-if="running" class="panel__progress"><div :style="{ width: `${progress * 100}%` }" /></div>
        <ul class="panel__list">
            <li v-for="scenario in SCENARIOS" :key="scenario.id" class="panel__item">
                <button class="panel__run" type="button" :disabled="!!running" @click="run([scenario.id])">
                    <span class="panel__icon" :class="results[scenario.id] && `panel__icon--${results[scenario.id]!.status}`">
                        {{ running === scenario.id ? '◐' : results[scenario.id] ? ICON[results[scenario.id]!.status] : '▷' }}
                    </span>
                    <span class="panel__text">
                        <strong>{{ scenario.label }}</strong>
                        <small v-if="results[scenario.id]">
                            {{ results[scenario.id]!.status }} · {{ (results[scenario.id]!.ms / 1000).toFixed(1) }} s
                            <template v-if="results[scenario.id]!.notes"> · {{ results[scenario.id]!.notes }}</template>
                        </small>
                        <small v-else>{{ scenario.description }}</small>
                    </span>
                </button>
            </li>
        </ul>
    </section>
</template>

<style scoped>
.panel__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
}
.panel h2 {
    margin: 0;
    font-size: 20px;
}
.panel__hint {
    margin: 4px 0 8px;
    color: #8e8e93;
    font-size: 13px;
}
.panel__actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
}
.panel__progress {
    height: 4px;
    margin: 10px 0 2px;
    border-radius: 2px;
    background: #e5e5ea;
    overflow: hidden;
}
.panel__progress div {
    height: 100%;
    background: #007aff;
    transition: width 0.1s linear;
}
.panel__list {
    list-style: none;
    padding: 0;
    margin: 8px 0 0;
}
.panel__item + .panel__item {
    border-top: 1px solid #eee;
}
.panel__run {
    all: unset;
    box-sizing: border-box;
    display: flex;
    gap: 10px;
    align-items: flex-start;
    width: 100%;
    padding: 8px 2px;
    cursor: pointer;
}
.panel__run:disabled {
    cursor: default;
    opacity: 0.6;
}
.panel__icon {
    width: 16px;
    color: #007aff;
    font-size: 14px;
    line-height: 20px;
}
.panel__icon--pass {
    color: #34c759;
}
.panel__icon--slow {
    color: #ff9500;
}
.panel__icon--fail {
    color: #ff3b30;
}
.panel__icon--skipped {
    color: #c7c7cc;
}
.panel__text {
    display: flex;
    flex-direction: column;
    font-size: 15px;
}
.panel__text small {
    color: #8e8e93;
    font-size: 12px;
}
</style>
