import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScenarios } from './test-support/conformance/load.js';
import { runTsScenario } from './test-support/conformance/tsRunner.js';

const scenarios = loadScenarios();

describe('conformance (TypeScript side)', () => {
    beforeEach(() => {
        // `flush()` keeps the real timer it captured at import, so only the
        // controller's own timers move with `advanceClock`.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('finds the shared scenario files', () => {
        expect(scenarios.length).toBeGreaterThan(0);
    });

    for (const { file, scenario } of scenarios) {
        it(`${file}: ${scenario.name}`, async () => {
            await runTsScenario(scenario);
        });
    }
});
