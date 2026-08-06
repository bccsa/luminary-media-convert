/**
 * Serialization metadata kept *beside* the parsed models rather than on them.
 *
 * Losslessness needs more than the semantic model: the original attribute
 * order, the attributes we do not model, the exact numeric spelling of a
 * duration, and where unmodeled lines sat relative to everything else. None of
 * that belongs on the public object shape — it would leak into `JSON.stringify`
 * (the HLS-edit API returns parsed masters over HTTP), into `toEqual`
 * assertions, and into every hand-built model a caller writes.
 *
 * So it lives in WeakMaps keyed by the model objects. Consequences worth
 * knowing:
 *
 * - a model that survives `JSON.parse(JSON.stringify(model))` keeps its
 *   semantics but loses byte fidelity — it rebuilds in canonical form;
 * - `{ ...variant }` produces an object with no metadata, which is exactly
 *   right: a modified copy should be serialized canonically;
 * - metadata is per module instance. The package ships dual CJS/ESM builds;
 *   mixing both copies in one process would mean two sets of WeakMaps.
 *
 * Internal module — not part of the package's public surface.
 */

import type { HlsAttribute } from './attributes';

/** What a source line carried, for entries built from an attribute list. */
const attributeSources = new WeakMap<object, HlsAttribute[]>();

export function setAttributeSource(target: object, attrs: HlsAttribute[]): void {
    attributeSources.set(target, attrs);
}

export function getAttributeSource(target: object): HlsAttribute[] {
    return attributeSources.get(target) ?? [];
}

/**
 * Copy one entry's attribute source onto a derived entry, optionally dropping
 * attributes the derivation removed (e.g. `VIDEO` when pinning an angle).
 */
export function copyAttributeSource(
    from: object,
    to: object,
    dropNames: readonly string[] = []
): void {
    const source = attributeSources.get(from);
    if (!source) return;
    attributeSources.set(
        to,
        dropNames.length === 0
            ? source
            : source.filter((a) => !dropNames.includes(a.name))
    );
}

/** Ordered contents of a playlist, including lines the model does not cover. */
const layouts = new WeakMap<object, unknown[]>();

export function setLayout(target: object, items: readonly unknown[]): void {
    layouts.set(target, items.slice());
}

export function getLayout(target: object): unknown[] | undefined {
    return layouts.get(target);
}

/** Order in which a playlist's header tags appeared. */
const headerOrders = new WeakMap<object, string[]>();

export function setHeaderOrder(target: object, names: readonly string[]): void {
    headerOrders.set(target, names.slice());
}

export function getHeaderOrder(target: object): string[] {
    return headerOrders.get(target) ?? [];
}

/** Exact source spelling of a numeric field (`#EXTINF:4.000000`). */
const numericTexts = new WeakMap<object, Record<string, string>>();

export function setNumericText(
    target: object,
    field: string,
    text: string
): void {
    const existing = numericTexts.get(target);
    if (existing) existing[field] = text;
    else numericTexts.set(target, { [field]: text });
}

export function getNumericText(
    target: object,
    field: string
): string | undefined {
    return numericTexts.get(target)?.[field];
}

/**
 * Emit header tags in the order the source used, appending any the source
 * lacked in canonical order.
 */
export function orderedHeaderNames(
    target: object,
    canonical: readonly string[]
): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const name of getHeaderOrder(target)) {
        if (canonical.includes(name) && !seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    for (const name of canonical) {
        if (!seen.has(name)) {
            seen.add(name);
            out.push(name);
        }
    }
    return out;
}
