/**
 * Reads `player-native/conformance/*.json` — the shared files, never a copy —
 * and refuses anything the format does not define, so a misspelt key fails the
 * scenario instead of silently skipping a step.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_ERROR_CODES } from '../../bridge.js';
import { STEP_SIDES, stepKind, type Scenario, type Step } from './scenario.js';

export const CONFORMANCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../conformance');

export interface ScenarioFile {
    file: string;
    scenario: Scenario;
}

export function loadScenarios(dir = CONFORMANCE_DIR): ScenarioFile[] {
    return readdirSync(dir)
        .filter((file) => file.endsWith('.json'))
        .sort()
        .map((file) => {
            const raw: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
            try {
                return { file, scenario: validate(raw) };
            } catch (error) {
                throw new Error(`${file}: ${(error as Error).message}`, { cause: error });
            }
        });
}

const TOP_LEVEL = new Set(['$schema', 'name', 'description', 'capabilities', 'fetch', 'steps']);
const CAPABILITIES = new Set([
    'variantSwitching',
    'pictureInPicture',
    'renderText',
    'live',
    'chunkWarming',
    'backgroundAudio',
    'inlineVideo',
    'muting',
    'subtitleSelection',
    'maxPlayers',
]);

/** The keys each step kind's body may carry; `null` means the body is not an object. */
const STEP_KEYS: Record<keyof typeof STEP_SIDES, Set<string> | null> = {
    drive: new Set(['start', 'controller', 'adapter', 'args', 'rejects']),
    call: new Set(['method', 'args', 'match', 'result', 'rejects']),
    event: new Set(['name', 'payload']),
    engine: null,
    advanceClock: null,
    expectNoEvents: null,
    expectEngine: null,
    expectAdapter: null,
    expectState: null,
    expectNoCalls: null,
    route: new Set(['uri', 'expect']),
};

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) throw new Error(`${where}: unknown key ${key}`);
    }
}

function validate(raw: unknown): Scenario {
    if (!isObject(raw)) throw new Error('a scenario is an object');
    onlyKeys(raw, TOP_LEVEL, 'scenario');
    if (typeof raw.name !== 'string' || raw.name === '') throw new Error('name is required');
    if (raw.capabilities !== undefined) {
        if (!isObject(raw.capabilities)) throw new Error('capabilities is an object');
        onlyKeys(raw.capabilities, CAPABILITIES, 'capabilities');
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('steps is a non-empty array');
    raw.steps.forEach((step, index) => validateStep(step, `step ${index}`));
    return raw as unknown as Scenario;
}

function validateStep(raw: unknown, where: string): void {
    if (!isObject(raw)) throw new Error(`${where}: a step is an object`);
    const kind = stepKind(raw as unknown as Step);
    const only = raw.only;
    if (only !== undefined && (only === 'ts' || only === 'native') === false) {
        throw new Error(`${where}: only is "ts" or "native"`);
    }
    if (only !== undefined && !STEP_SIDES[kind].includes(only as 'ts' | 'native')) {
        throw new Error(`${where}: a ${kind} step cannot be restricted to ${String(only)}`);
    }
    const body = raw[kind];
    const keys = STEP_KEYS[kind];
    if (keys) {
        if (!isObject(body)) throw new Error(`${where}: ${kind} takes an object`);
        onlyKeys(body, keys, `${where} (${kind})`);
    }
    const rejects = isObject(body) ? body.rejects : undefined;
    if (rejects !== undefined && !(BRIDGE_ERROR_CODES as readonly unknown[]).includes(rejects)) {
        throw new Error(`${where}: ${String(rejects)} is not a bridge error code`);
    }

    switch (kind) {
        case 'drive': {
            const drive = body as Record<string, unknown>;
            const targets = ['start', 'controller', 'adapter'].filter((key) => key in drive);
            if (targets.length !== 1) throw new Error(`${where}: drive names one of start, controller, adapter`);
            if ('start' in drive && 'args' in drive) throw new Error(`${where}: start takes no args`);
            if (!('start' in drive) && 'rejects' in drive) throw new Error(`${where}: only start can reject`);
            break;
        }
        case 'call': {
            const call = body as Record<string, unknown>;
            if (typeof call.method !== 'string') throw new Error(`${where}: call.method is required`);
            if ('result' in call && 'rejects' in call) throw new Error(`${where}: result or rejects, not both`);
            break;
        }
        case 'event': {
            const event = body as Record<string, unknown>;
            if (typeof event.name !== 'string' || !isObject(event.payload)) {
                throw new Error(`${where}: event takes a name and a payload object`);
            }
            break;
        }
        case 'engine':
            if (!isObject(body) || typeof body.signal !== 'string') {
                throw new Error(`${where}: engine takes { signal, ...args }`);
            }
            if (!ENGINE_SIGNALS.has(body.signal)) throw new Error(`${where}: unknown engine signal ${body.signal}`);
            break;
        case 'advanceClock':
            if (typeof body !== 'number' || !(body > 0)) throw new Error(`${where}: advanceClock takes seconds > 0`);
            break;
        case 'expectNoEvents':
        case 'expectNoCalls':
            if (body !== true) throw new Error(`${where}: ${kind} takes true`);
            break;
        case 'expectAdapter':
        case 'expectState':
            if (!isObject(body)) throw new Error(`${where}: ${kind} takes an object`);
            break;
        case 'route': {
            const route = body as Record<string, unknown>;
            if (typeof route.uri !== 'string' || !('expect' in route)) {
                throw new Error(`${where}: route takes a uri and an expect`);
            }
            break;
        }
        case 'expectEngine':
            break;
    }
}

/** The `FakeEngine` vocabulary. Adding a signal is a change to the format. */
export const ENGINE_SIGNALS = new Set([
    'readyToPlay',
    'playing',
    'paused',
    'buffering',
    'seeked',
    'ended',
    'tracks',
    'variants',
    'failed',
    'bufferedTo',
    'position',
    'rate',
    'muted',
]);
