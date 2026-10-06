/**
 * The native side of a conformance scenario, replayed against a
 * {@link ConformanceHarness}: the same logic as the Kotlin and Swift
 * `ScenarioRunner`, so the reference native side is held to the scenarios the
 * way both platforms are.
 */

import { routeJson, type ConformanceHarness } from './harness.js';
import { MatchError, Refs } from './match.js';
import { appliesTo, stepKind, type Json, type JsonObject, type Scenario, type Step } from './scenario.js';

export const DEFAULT_CAPABILITIES: JsonObject = {
    variantSwitching: false,
    pictureInPicture: false,
    renderText: false,
    live: false,
    chunkWarming: false,
    backgroundAudio: false,
    inlineVideo: false,
    muting: false,
    subtitleSelection: false,
    maxPlayers: 1,
};

/** Runs every native step; throws naming the first that fails. */
export function runNativeScenario(scenario: Scenario, harness: ConformanceHarness): void {
    harness.start({ ...DEFAULT_CAPABILITIES, ...(scenario.capabilities as JsonObject | undefined) });
    const run = new NativeRun(harness);
    for (const [index, step] of scenario.steps.entries()) {
        if (!appliesTo(step, 'native')) continue;
        try {
            run.step(step);
        } catch (error) {
            throw new MatchError(`step ${index} (${stepKind(step)}): ${(error as Error).message}`);
        }
    }
    try {
        run.expectNoEvents();
    } catch (error) {
        throw new MatchError(`end of scenario: ${(error as Error).message}`);
    }
}

class NativeRun {
    private readonly refs = new Refs();
    private pending: JsonObject[] = [];

    constructor(private readonly harness: ConformanceHarness) {}

    step(step: Step): void {
        if ('call' in step) return this.call(step.call);
        if ('event' in step) return this.event(step.event);
        if ('engine' in step) {
            const { signal, ...args } = step.engine;
            this.harness.engine(signal, this.refs.issue(args) as JsonObject);
            return;
        }
        if ('advanceClock' in step) return this.harness.advanceClock(step.advanceClock);
        if ('expectNoEvents' in step) return this.expectNoEvents();
        if ('expectEngine' in step) {
            this.refs.assert(this.harness.drainEngineCalls(), step.expectEngine, 'engine');
            return;
        }
        if ('route' in step) {
            const { uri, expect } = step.route;
            this.refs.assert(routeJson(this.harness.route(uri)), expect, `route(${uri})`);
            return;
        }
        throw new MatchError(`${stepKind(step)} has no native side`);
    }

    private call(call: Extract<Step, { call: unknown }>['call']): void {
        const args = this.refs.issue(call.args ?? {}) as JsonObject;
        const result = this.harness.call(call.method, args);
        if ('resolved' in result) {
            if (call.rejects) {
                throw new MatchError(`${call.method}: expected a ${call.rejects} rejection, got ${JSON.stringify(result.resolved)}`);
            }
            if (call.result !== undefined) this.refs.assert(result.resolved, call.result, `${call.method}.result`);
            return;
        }
        const { code, message } = result.rejected;
        if (!call.rejects) throw new MatchError(`${call.method}: rejected ${code} (${message})`);
        if (call.rejects !== code) throw new MatchError(`${call.method}: expected a ${call.rejects} rejection, got ${code}`);
    }

    private event(event: { name: string; payload: JsonObject }): void {
        if (this.pending.length === 0) this.pending = this.harness.drainEvents();
        const emitted = this.pending.shift();
        if (!emitted) throw new MatchError(`expected a ${event.name} event; none was emitted`);
        if (emitted.name !== event.name) {
            throw new MatchError(`expected a ${event.name} event, got ${String(emitted.name)} ${JSON.stringify(emitted.payload)}`);
        }
        this.refs.assert(emitted.payload as Json, event.payload, `${event.name}.payload`);
    }

    expectNoEvents(): void {
        this.pending.push(...this.harness.drainEvents());
        if (this.pending.length > 0) {
            throw new MatchError(`unasserted events: ${this.pending.map((event) => JSON.stringify(event)).join(', ')}`);
        }
    }
}
