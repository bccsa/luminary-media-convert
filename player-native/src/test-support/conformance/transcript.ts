/**
 * Transcripts: the reference native side's whole conversation with the runner,
 * per scenario, committed under `conformance/selftest/transcripts/`. The Kotlin
 * and Swift runners replay each scenario against its transcript, which fails
 * unless they drive a harness exactly as the TypeScript runner does.
 */

import type { CallResult, ConformanceHarness, RouteResult } from './harness.js';
import type { JsonObject } from './scenario.js';

export type TranscriptOp =
    | { op: 'start'; capabilities: JsonObject }
    | { op: 'call'; method: string; args: JsonObject; result: JsonObject }
    | { op: 'engine'; signal: string; args: JsonObject }
    | { op: 'advanceClock'; seconds: number }
    | { op: 'drainEvents'; events: JsonObject[] }
    | { op: 'drainEngineCalls'; calls: JsonObject[] }
    | { op: 'route'; uri: string; result: JsonObject };

/** A route result as data: bytes travel as lowercase hex. */
function routeData(result: RouteResult): JsonObject {
    if ('failed' in result) return { failed: result.failed };
    const { bytes, contentType } = result.served;
    return { served: { contentType, hex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') } };
}

/** The runner may consume what it is handed; a transcript keeps what was handed. */
function copy<T>(value: T): T {
    return structuredClone(value);
}

export class RecordingHarness implements ConformanceHarness {
    readonly ops: TranscriptOp[] = [];

    constructor(private readonly inner: ConformanceHarness) {}

    start(capabilities: JsonObject): void {
        this.ops.push({ op: 'start', capabilities: copy(capabilities) });
        this.inner.start(capabilities);
    }

    call(method: string, args: JsonObject): CallResult {
        const result = this.inner.call(method, args);
        this.ops.push({
            op: 'call',
            method,
            args: copy(args),
            result: 'resolved' in result ? { resolved: copy(result.resolved) } : { rejected: copy(result.rejected) },
        });
        return result;
    }

    engine(signal: string, args: JsonObject): void {
        this.ops.push({ op: 'engine', signal, args: copy(args) });
        this.inner.engine(signal, args);
    }

    advanceClock(seconds: number): void {
        this.ops.push({ op: 'advanceClock', seconds });
        this.inner.advanceClock(seconds);
    }

    drainEvents(): JsonObject[] {
        const events = this.inner.drainEvents();
        this.ops.push({ op: 'drainEvents', events: copy(events) });
        return events;
    }

    drainEngineCalls(): JsonObject[] {
        const calls = this.inner.drainEngineCalls();
        this.ops.push({ op: 'drainEngineCalls', calls: copy(calls) });
        return calls;
    }

    route(uri: string): RouteResult {
        const result = this.inner.route(uri);
        this.ops.push({ op: 'route', uri, result: routeData(result) });
        return result;
    }
}
