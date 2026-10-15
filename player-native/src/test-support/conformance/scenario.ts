/**
 * The conformance scenario format, as TypeScript. `conformance/README.md` is
 * the normative description; the Kotlin and Swift runners model the same
 * shapes by hand.
 */

import type { BridgeCapabilities, BridgeErrorCode } from '../../bridge.js';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Side = 'ts' | 'native';

export interface Scenario {
    name: string;
    description?: string;
    /** Overrides the defaults of the fake plugin (TS) and the `FakeEngine` harness (native). */
    capabilities?: Partial<BridgeCapabilities>;
    /** TS only: URL → body for the controller's `fetchImpl`. `@NAME` names a `player-core` fixture. */
    fetch?: Record<string, string>;
    steps: Step[];
}

interface StepBase {
    /** Restricts a step to one side; without it the step kind decides. */
    only?: Side;
    /** Free text for the reader; no runner acts on it. */
    note?: string;
}

export type DriveStep = StepBase & {
    drive:
        | {
              start: { skipBackSeconds?: number; skipForwardSeconds?: number; freshContext?: boolean };
              rejects?: BridgeErrorCode;
          }
        | { controller: string; args?: Json }
        | { adapter: string; args?: Json };
};

export type CallStep = StepBase & {
    call: {
        method: string;
        args?: JsonObject;
        /** TS only: what the issued args must match, when `args` carries content only native needs verbatim. */
        match?: Json;
        result?: Json;
        rejects?: BridgeErrorCode;
    };
};

export type EventStep = StepBase & { event: { name: string; payload: JsonObject } };
export type EngineStep = StepBase & { engine: { signal: string } & JsonObject };
export type AdvanceClockStep = StepBase & { advanceClock: number };
export type ExpectNoEventsStep = StepBase & { expectNoEvents: true };
export type ExpectEngineStep = StepBase & { expectEngine: Json };
export type ExpectAdapterStep = StepBase & { expectAdapter: JsonObject };
export type ExpectStateStep = StepBase & { expectState: JsonObject };
export type ExpectNoCallsStep = StepBase & { expectNoCalls: true };
export type RouteStep = StepBase & { route: { uri: string; expect: Json } };

export type Step =
    | DriveStep
    | CallStep
    | EventStep
    | EngineStep
    | AdvanceClockStep
    | ExpectNoEventsStep
    | ExpectEngineStep
    | ExpectAdapterStep
    | ExpectStateStep
    | ExpectNoCallsStep
    | RouteStep;

export type StepKind =
    | 'drive'
    | 'call'
    | 'event'
    | 'engine'
    | 'advanceClock'
    | 'expectNoEvents'
    | 'expectEngine'
    | 'expectAdapter'
    | 'expectState'
    | 'expectNoCalls'
    | 'route';

/** The sides a step kind applies to when it carries no `only`. */
export const STEP_SIDES: Record<StepKind, readonly Side[]> = {
    drive: ['ts'],
    call: ['ts', 'native'],
    event: ['ts', 'native'],
    engine: ['native'],
    advanceClock: ['ts', 'native'],
    expectNoEvents: ['native'],
    expectEngine: ['native'],
    expectAdapter: ['ts'],
    expectState: ['ts'],
    expectNoCalls: ['ts'],
    route: ['native'],
};

export function stepKind(step: Step): StepKind {
    const kinds = Object.keys(step).filter((key) => key !== 'only' && key !== 'note');
    if (kinds.length !== 1 || !(kinds[0]! in STEP_SIDES)) {
        throw new Error(`A step names exactly one kind; got ${JSON.stringify(Object.keys(step))}`);
    }
    return kinds[0] as StepKind;
}

export function appliesTo(step: Step, side: Side): boolean {
    const kind = stepKind(step);
    if (step.only) {
        if (!STEP_SIDES[kind].includes(step.only)) {
            throw new Error(`A ${kind} step cannot be restricted to ${step.only}`);
        }
        return step.only === side;
    }
    return STEP_SIDES[kind].includes(side);
}
