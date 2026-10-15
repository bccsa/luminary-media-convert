/**
 * Refs and matchers for conformance scenarios — ported by hand to the Kotlin
 * and Swift runners, so it stays small and its rules live in
 * `conformance/README.md`.
 */

import type { Json, JsonObject } from './scenario.js';

const REF = /^\$[A-Za-z][A-Za-z0-9_]*$/;
const MATCHERS = new Set(['$absent', '$any', '$prefix', '$length', '$each', '$contains', '$not']);

export class MatchError extends Error {}

function isObject(value: Json | undefined): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRef(value: Json | undefined): value is string {
    return typeof value === 'string' && REF.test(value);
}

/** An object whose keys all start with `$` is a matcher, not a subset to match. */
function isMatcher(value: Json | undefined): value is JsonObject {
    if (!isObject(value)) return false;
    const keys = Object.keys(value);
    return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

export class Refs {
    private readonly bound = new Map<string, Json>();

    get(name: string): Json | undefined {
        return this.bound.get(name);
    }

    private bind(name: string, value: Json, path: string): void {
        for (const [other, held] of this.bound) {
            if (deepEqual(held, value)) {
                throw new MatchError(
                    `${path}: ${name} would bind ${JSON.stringify(value)}, already held by ${other}`,
                );
            }
        }
        this.bound.set(name, value);
    }

    /**
     * A value to send: bound refs are substituted, an unbound ref binds to its
     * own name without the `$`, and `{ "$absent": true }` drops its key.
     */
    issue(value: Json, path = '$'): Json {
        if (isRef(value)) {
            const held = this.bound.get(value);
            if (held !== undefined) return held;
            const minted = value.slice(1);
            this.bind(value, minted, path);
            return minted;
        }
        if (Array.isArray(value)) return value.map((item, i) => this.issue(item, `${path}[${i}]`));
        if (isMatcher(value)) {
            throw new MatchError(`${path}: a matcher cannot be sent (${JSON.stringify(value)})`);
        }
        if (isObject(value)) {
            const out: JsonObject = {};
            for (const [key, item] of Object.entries(value)) {
                if (isMatcher(item) && Object.keys(item).length === 1 && item.$absent === true) continue;
                out[key] = this.issue(item, `${path}.${key}`);
            }
            return out;
        }
        return value;
    }

    /** Throws a {@link MatchError} naming the first path that does not match. */
    assert(actual: Json | undefined, expected: Json, path = '$'): void {
        if (isRef(expected)) {
            const held = this.bound.get(expected);
            if (held === undefined) {
                if (actual === undefined) throw new MatchError(`${path}: missing, expected ${expected}`);
                this.bind(expected, actual, path);
                return;
            }
            if (!deepEqual(actual, held)) {
                throw new MatchError(
                    `${path}: expected ${expected} = ${JSON.stringify(held)}, got ${JSON.stringify(actual)}`,
                );
            }
            return;
        }
        if (isMatcher(expected)) {
            this.assertMatcher(actual, expected, path);
            return;
        }
        if (actual === undefined) throw new MatchError(`${path}: missing, expected ${JSON.stringify(expected)}`);
        if (Array.isArray(expected)) {
            if (!Array.isArray(actual)) throw new MatchError(`${path}: expected an array, got ${JSON.stringify(actual)}`);
            if (actual.length !== expected.length) {
                throw new MatchError(`${path}: expected ${expected.length} items, got ${actual.length}`);
            }
            expected.forEach((item, i) => this.assert(actual[i], item, `${path}[${i}]`));
            return;
        }
        if (isObject(expected)) {
            if (!isObject(actual)) throw new MatchError(`${path}: expected an object, got ${JSON.stringify(actual)}`);
            for (const [key, item] of Object.entries(expected)) {
                this.assert(actual[key], item, `${path}.${key}`);
            }
            return;
        }
        if (!deepEqual(actual, expected)) {
            throw new MatchError(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
        }
    }

    private assertMatcher(actual: Json | undefined, matcher: JsonObject, path: string): void {
        for (const [key, operand] of Object.entries(matcher)) {
            if (!MATCHERS.has(key)) throw new MatchError(`${path}: unknown matcher ${key}`);
            switch (key) {
                case '$absent':
                    if (operand !== true) throw new MatchError(`${path}: $absent takes true`);
                    if (actual !== undefined) {
                        throw new MatchError(`${path}: expected absent, got ${JSON.stringify(actual)}`);
                    }
                    break;
                case '$any':
                    if (actual === undefined) throw new MatchError(`${path}: missing`);
                    break;
                case '$prefix':
                    if (typeof actual !== 'string' || !actual.startsWith(operand as string)) {
                        throw new MatchError(`${path}: expected a string starting ${JSON.stringify(operand)}, got ${JSON.stringify(actual)}`);
                    }
                    break;
                case '$length':
                    if ((!Array.isArray(actual) && typeof actual !== 'string') || actual.length !== operand) {
                        throw new MatchError(`${path}: expected length ${String(operand)}, got ${JSON.stringify(actual)}`);
                    }
                    break;
                case '$each':
                    if (!Array.isArray(actual)) throw new MatchError(`${path}: expected an array`);
                    actual.forEach((item, i) => this.assert(item, operand, `${path}[${i}]`));
                    break;
                case '$contains':
                    if (!Array.isArray(actual) || !actual.some((item) => this.tries(item, operand))) {
                        throw new MatchError(`${path}: no item matches ${JSON.stringify(operand)} in ${JSON.stringify(actual)}`);
                    }
                    break;
                case '$not':
                    if (this.tries(actual, operand)) {
                        throw new MatchError(`${path}: expected not to match ${JSON.stringify(operand)}`);
                    }
                    break;
            }
        }
    }

    /**
     * Whether `actual` matches, without keeping bindings. Refs inside `$contains`
     * and `$not` must already be bound; an attempt never binds one.
     */
    private tries(actual: Json | undefined, expected: Json): boolean {
        const probe = new Refs();
        for (const [name, value] of this.bound) probe.bound.set(name, value);
        try {
            probe.assert(actual, expected);
        } catch (error) {
            if (error instanceof MatchError) return false;
            throw error;
        }
        return probe.bound.size === this.bound.size;
    }
}

/** JSON equality; numbers compare by value, so 1 and 1.0 are equal, as on every runner. */
export function deepEqual(a: Json | undefined, b: Json | undefined): boolean {
    if (a === b) return true;
    if (Array.isArray(a)) {
        return Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }
    if (isObject(a) && isObject(b)) {
        const keys = Object.keys(a);
        return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
    }
    return false;
}
