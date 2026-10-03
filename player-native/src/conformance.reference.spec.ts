import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFORMANCE_DIR, loadScenarios } from './test-support/conformance/load.js';
import { runNativeScenario } from './test-support/conformance/nativeRunner.js';
import { ReferenceHarness } from './test-support/conformance/reference/PlayerRegistry.js';
import { RecordingHarness } from './test-support/conformance/transcript.js';

const TRANSCRIPTS = join(CONFORMANCE_DIR, 'selftest/transcripts');
/** `npm -w player-native run conformance:transcripts` rewrites them after a scenario changes. */
const UPDATE = process.env.UPDATE_TRANSCRIPTS === '1';

/**
 * The native half of every scenario, against the reference native side. It is
 * what shows a scenario is satisfiable before either platform runs it, and the
 * model plans 02 and 03 port. Its conversation is the transcript the Kotlin and
 * Swift runners are held to.
 */
describe('conformance (native side, reference implementation)', () => {
    const scenarios = loadScenarios();

    it('finds the shared scenario files', () => {
        expect(scenarios.length).toBeGreaterThan(0);
    });

    for (const { file, scenario } of scenarios) {
        it(`${file}: ${scenario.name}`, () => {
            const harness = new RecordingHarness(new ReferenceHarness());
            runNativeScenario(scenario, harness);

            const transcript = `${JSON.stringify({ scenario: file, ops: harness.ops }, null, 1)}\n`;
            const path = join(TRANSCRIPTS, file);
            if (UPDATE) {
                mkdirSync(TRANSCRIPTS, { recursive: true });
                writeFileSync(path, transcript);
                return;
            }
            expect(existsSync(path), `${file} has no transcript: run conformance:transcripts`).toBe(true);
            expect(readFileSync(path, 'utf8'), `${file}'s transcript is stale: run conformance:transcripts`).toBe(
                transcript,
            );
        });
    }
});
