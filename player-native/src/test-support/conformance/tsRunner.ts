/**
 * The TypeScript side of a conformance scenario: a real `PlayerController`
 * over `NativeBridgeAdapter` + `NativeServeStrategy`, talking to a
 * {@link FakePlugin} that asserts `call` steps and injects `event` steps.
 *
 * A `call` is asserted after the `drive` that caused it, but the plugin has to
 * answer it when it is made; so every TS `call` step is queued per method up
 * front, and the plugin answers the Nth call of a method from the Nth step
 * naming it.
 */

import { vi } from 'vitest';
import * as fixtures from '../../../../player-core/src/test-support/index.js';
import { flush, makeFetch } from '../../../../player-core/src/test-support/index.js';
import type { BridgeInfo } from '../../bridge.js';
import * as entry from '../../createNativePlayer.js';
import type { NativePlayer } from '../../createNativePlayer.js';
import { FakePlugin, type ScriptedAnswer } from '../fakePlugin.js';
import { MatchError, Refs } from './match.js';
import {
    appliesTo,
    stepKind,
    type CallStep,
    type Json,
    type JsonObject,
    type Scenario,
    type Step,
} from './scenario.js';

type Entry = typeof entry;

/** Runs every TS step of `scenario`; throws on the first that fails. */
export async function runTsScenario(scenario: Scenario): Promise<void> {
    const run = new TsRun(scenario);
    try {
        for (const [index, step] of scenario.steps.entries()) {
            if (!appliesTo(step, 'ts')) continue;
            try {
                await run.step(step);
            } catch (error) {
                throw located(error, `step ${index} (${stepKind(step)})`);
            }
        }
        try {
            run.expectNoCalls();
        } catch (error) {
            throw located(error, 'end of scenario');
        }
    } finally {
        run.dispose();
    }
}

function located(error: unknown, where: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    return new Error(`${where}: ${message}`, { cause: error });
}

class TsRun {
    private readonly refs = new Refs();
    private readonly plugin: FakePlugin;
    private readonly answers = new Map<string, CallStep['call'][]>();
    private readonly fetchImpl: typeof fetch;
    private entry: Entry = entry;
    private player: NativePlayer | null = null;
    private consumed = 0;

    constructor(scenario: Scenario) {
        this.plugin = new FakePlugin(scenario.capabilities);
        for (const step of scenario.steps) {
            if (!('call' in step) || !appliesTo(step, 'ts')) continue;
            const queue = this.answers.get(step.call.method) ?? [];
            queue.push(step.call);
            this.answers.set(step.call.method, queue);
        }
        this.plugin.script = (method) => this.answer(method);

        const routes: Record<string, string> = {};
        for (const [url, body] of Object.entries(scenario.fetch ?? {})) {
            routes[url] = resolveFixtures(body) as string;
        }
        this.fetchImpl = makeFetch(routes).fetchImpl;
    }

    private answer(method: string): ScriptedAnswer | undefined {
        const call = this.answers.get(method)?.shift();
        if (!call) return undefined;
        if (call.rejects) return { rejects: call.rejects };
        if (call.result === undefined) return undefined;
        const result = this.refs.issue(call.result);
        if (method === 'getInfo') {
            const partial = result as Partial<BridgeInfo>;
            return {
                result: {
                    ...this.plugin.info,
                    ...partial,
                    capabilities: { ...this.plugin.info.capabilities, ...partial.capabilities },
                },
            };
        }
        return { result };
    }

    async step(step: Step): Promise<void> {
        if ('drive' in step) return this.drive(step.drive);
        if ('call' in step) return this.call(step.call);
        if ('event' in step) {
            const { playerId, loadId, ...payload } = this.refs.issue(step.event.payload) as JsonObject;
            this.plugin.emit(
                step.event.name as never,
                { playerId: playerId as string, loadId: loadId as string },
                payload as never,
            );
            await flush();
            return;
        }
        if ('advanceClock' in step) {
            await vi.advanceTimersByTimeAsync(step.advanceClock * 1000);
            await flush();
            return;
        }
        if ('expectAdapter' in step) {
            const adapter = this.started().adapter as unknown as Record<string, unknown>;
            for (const [member, expected] of Object.entries(step.expectAdapter)) {
                this.refs.assert(readMember(adapter, member), expected, `adapter.${member}`);
            }
            return;
        }
        if ('expectState' in step) {
            this.refs.assert(toJson(this.started().controller.getState()), step.expectState, 'state');
            return;
        }
        if ('expectNoCalls' in step) return this.expectNoCalls();
        throw new Error(`${stepKind(step)} has no TS side`);
    }

    private async drive(drive: Extract<Step, { drive: unknown }>['drive']): Promise<void> {
        if ('start' in drive) {
            const { freshContext, ...options } = drive.start;
            if (freshContext) {
                // A new JavaScript context: module state (the handshake memo)
                // starts over, and the previous player is abandoned, not destroyed.
                vi.resetModules();
                this.entry = await import('../../createNativePlayer.js');
            }
            const started = this.entry.createNativePlayer({
                ...options,
                plugin: this.plugin,
                controller: { fetchImpl: this.fetchImpl, prefetch: { enabled: false } },
                report: () => undefined,
            });
            if (drive.rejects) {
                const failure = await started.then(
                    () => null,
                    (error: unknown) => error as { code?: string },
                );
                if (failure?.code !== drive.rejects) {
                    throw new MatchError(`start: expected a ${drive.rejects} rejection, got ${String(failure?.code ?? 'success')}`);
                }
            } else {
                this.player = await started;
            }
            await flush();
            return;
        }
        const [target, method] =
            'controller' in drive
                ? [this.started().controller, drive.controller]
                : [this.started().adapter, drive.adapter];
        const fn = (target as unknown as Record<string, unknown>)[method];
        if (typeof fn !== 'function') throw new Error(`No method ${method} to drive`);
        const args = drive.args === undefined ? [] : resolveFixtures(drive.args);
        await fn.apply(target, Array.isArray(args) ? args : [args]);
        await flush();
    }

    private call(call: CallStep['call']): void {
        const issued = this.plugin.calls[this.consumed];
        if (!issued) throw new MatchError(`expected a ${call.method} call; none was made`);
        this.consumed += 1;
        if (issued.method !== call.method) {
            throw new MatchError(`expected a ${call.method} call, got ${issued.method}`);
        }
        const expected = call.match ?? call.args;
        if (expected !== undefined) {
            this.refs.assert(toJson(issued.args ?? {}), expected, `${call.method}.args`);
        }
    }

    expectNoCalls(): void {
        const left = this.plugin.calls.slice(this.consumed);
        if (left.length > 0) {
            throw new MatchError(`unasserted calls: ${left.map((call) => call.method).join(', ')}`);
        }
    }

    private started(): NativePlayer {
        if (!this.player) throw new Error('No player: drive start first');
        return this.player;
    }

    dispose(): void {
        this.player?.controller.destroy();
    }
}

/** A getter (`get…`) is called; a function-valued member reads as `true`. */
function readMember(target: Record<string, unknown>, member: string): Json | undefined {
    const value = target[member];
    if (typeof value === 'function') {
        return member.startsWith('get') ? toJson(value.call(target)) : true;
    }
    return toJson(value);
}

/** The wire's view of a value: `Infinity` is `null`, an `undefined` key is absent. */
function toJson(value: unknown): Json | undefined {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value)) as Json;
}

/** `@NAME` names a string export of `player-core`'s test-support. */
function resolveFixtures(value: Json): Json {
    if (typeof value === 'string' && value.startsWith('@')) {
        const fixture = (fixtures as Record<string, unknown>)[value.slice(1)];
        if (typeof fixture !== 'string') throw new Error(`No string fixture ${value}`);
        return fixture;
    }
    if (Array.isArray(value)) return value.map(resolveFixtures);
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveFixtures(item)]));
    }
    return value;
}
