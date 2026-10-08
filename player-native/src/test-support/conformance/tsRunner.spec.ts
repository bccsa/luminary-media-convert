import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScenarios } from './load.js';
import type { Scenario } from './scenario.js';
import { runTsScenario } from './tsRunner.js';

const handshake: Scenario['steps'] = [
    { drive: { start: {} } },
    { call: { method: 'getInfo' } },
    { call: { method: 'reset' } },
    { call: { method: 'create', result: { playerId: '$player' } } },
];

/** A runner that passes everything proves nothing; each of these must fail. */
describe('the TS conformance runner rejects', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] }));
    afterEach(() => vi.useRealTimers());

    const broken: Record<string, Scenario['steps']> = {
        'a call that was never made': [...handshake, { call: { method: 'play' } }],
        'a call made but never asserted': handshake.slice(0, 3),
        'calls asserted out of order': [handshake[0]!, handshake[2]!, handshake[1]!, handshake[3]!],
        'args that do not match': [
            handshake[0]!,
            handshake[1]!,
            handshake[2]!,
            { call: { method: 'create', args: { skipBackSeconds: 99 } } },
        ],
        'a ref bound to a different value': [
            ...handshake,
            { event: { name: 'timeupdate', payload: { playerId: '$player', loadId: '$l', currentTime: 3 } } },
            { expectAdapter: { getCurrentTime: 3 } },
        ],
        'a state that does not hold': [...handshake, { expectState: { playing: true } }],
        'a start expected to reject that succeeds': [
            { drive: { start: {}, rejects: 'protocol-mismatch' } },
            ...handshake.slice(1),
        ],
    };

    for (const [name, steps] of Object.entries(broken)) {
        it(name, async () => {
            await expect(runTsScenario({ name, steps })).rejects.toThrow();
        });
    }
});

describe('the scenario loader rejects', () => {
    const cases: Record<string, unknown> = {
        'an unknown step kind': { name: 'x', steps: [{ expectNothing: true }] },
        'two kinds in one step': { name: 'x', steps: [{ advanceClock: 1, expectNoEvents: true }] },
        'a step restricted to a side it has no meaning on': { name: 'x', steps: [{ engine: { signal: 'playing' }, only: 'ts' }] },
        'an unknown engine signal': { name: 'x', steps: [{ engine: { signal: 'teleport' } }] },
        'an unknown call key': { name: 'x', steps: [{ call: { method: 'play', arg: {} } }] },
        'a rejection code the bridge does not define': { name: 'x', steps: [{ call: { method: 'play', rejects: 'oops' } }] },
        'an unknown capability': { name: 'x', capabilities: { casting: true }, steps: [{ expectNoEvents: true }] },
    };

    for (const [name, scenario] of Object.entries(cases)) {
        it(name, async () => {
            const { mkdtempSync, writeFileSync } = await import('node:fs');
            const { tmpdir } = await import('node:os');
            const { join } = await import('node:path');
            const dir = mkdtempSync(join(tmpdir(), 'conformance-'));
            writeFileSync(join(dir, 'bad.json'), JSON.stringify(scenario));
            expect(() => loadScenarios(dir)).toThrow();
        });
    }
});
