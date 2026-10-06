import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFORMANCE_DIR } from './load.js';
import { MatchError, Refs } from './match.js';
import type { Json } from './scenario.js';

type Op =
    | { assert: { expected: Json; actual?: Json }; ok: boolean }
    | { issue: Json; result?: Json; error?: true };

const { cases } = JSON.parse(
    readFileSync(join(CONFORMANCE_DIR, 'selftest/match-cases.json'), 'utf8'),
) as { cases: { name: string; ops: Op[] }[] };

describe('conformance refs and matchers (shared cases)', () => {
    for (const { name, ops } of cases) {
        it(name, () => {
            const refs = new Refs();
            for (const op of ops) {
                if ('assert' in op) {
                    const run = () => refs.assert(op.assert.actual, op.assert.expected);
                    if (op.ok) run();
                    else expect(run).toThrow(MatchError);
                } else if (op.error) {
                    expect(() => refs.issue(op.issue)).toThrow(MatchError);
                } else {
                    expect(refs.issue(op.issue)).toEqual(op.result);
                }
            }
        });
    }
});
