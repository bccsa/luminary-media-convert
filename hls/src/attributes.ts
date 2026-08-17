/**
 * HLS attribute-list parsing and serialization.
 *
 * An attribute list is the `NAME=VALUE,NAME="VALUE"` tail of tags such as
 * `#EXT-X-STREAM-INF`, `#EXT-X-MEDIA`, `#EXT-X-KEY` and `#EXT-X-MAP`. Values
 * are either quoted-strings (which may contain commas) or bare tokens.
 *
 * Internal module — not part of the package's public surface.
 */

export interface HlsAttribute {
    name: string;
    value: string;
    quoted: boolean;
    /** A bare token with no `=` at all (non-standard; preserved verbatim). */
    bare?: boolean;
}

/** Split an attribute list, honouring quoted values that contain commas. */
export function parseAttributeList(input: string): HlsAttribute[] {
    const attrs: HlsAttribute[] = [];
    let i = 0;

    while (i < input.length) {
        while (i < input.length && /[,\s]/.test(input[i])) i++;
        if (i >= input.length) break;

        let name = '';
        while (i < input.length && input[i] !== '=' && input[i] !== ',') {
            name += input[i++];
        }
        name = name.trim();

        if (i < input.length && input[i] === '=') {
            i++;
            if (input[i] === '"') {
                i++;
                let value = '';
                while (i < input.length && input[i] !== '"') value += input[i++];
                i++; // closing quote
                attrs.push({ name, value, quoted: true });
                // Ignore any stray characters between the closing quote and
                // the next separator rather than folding them into the value.
                while (i < input.length && input[i] !== ',') i++;
            } else {
                let value = '';
                while (i < input.length && input[i] !== ',') value += input[i++];
                attrs.push({ name, value: value.trim(), quoted: false });
            }
        } else if (name) {
            attrs.push({ name, value: '', quoted: false, bare: true });
        }
    }

    return attrs;
}

export function formatAttribute(attr: HlsAttribute): string {
    if (attr.bare) return attr.name;
    return attr.quoted
        ? `${attr.name}="${attr.value}"`
        : `${attr.name}=${attr.value}`;
}

export function formatAttributeList(attrs: HlsAttribute[]): string {
    return attrs.map(formatAttribute).join(',');
}

/** Convenience constructor that drops absent values. */
export function attr(
    name: string,
    value: string | number | undefined,
    quoted: boolean
): HlsAttribute | undefined {
    if (value === undefined) return undefined;
    return { name, value: String(value), quoted };
}

/**
 * Two attributes carry the same information when their text matches, or when
 * both are unquoted numbers of equal value. The latter is what lets
 * `FRAME-RATE=29.970` survive a round-trip through a JS number.
 */
function equivalent(a: HlsAttribute, b: HlsAttribute): boolean {
    if (!!a.bare !== !!b.bare) return false;
    if (a.quoted !== b.quoted) return false;
    if (a.value === b.value) return true;
    if (a.quoted) return false;
    const na = Number(a.value);
    const nb = Number(b.value);
    return (
        a.value.trim() !== '' &&
        b.value.trim() !== '' &&
        Number.isFinite(na) &&
        Number.isFinite(nb) &&
        na === nb
    );
}

/**
 * Merge the attributes a model currently expresses with the ones the source
 * line actually carried, so that serializing an unmodified entry reproduces
 * the original bytes.
 *
 * - attribute order follows the source, with names the source lacked appended
 *   in `modeledNames` order;
 * - an attribute the model still expresses is emitted from the source when the
 *   two are equivalent (preserving e.g. `29.970`), otherwise from the model;
 * - an attribute the model *could* express but no longer does is dropped;
 * - anything else the source carried is emitted verbatim.
 *
 * @param modeledNames every attribute name the model knows how to express —
 *   doubles as the canonical output order for new attributes.
 */
export function mergeAttributes(
    original: HlsAttribute[],
    modeled: (HlsAttribute | undefined)[],
    modeledNames: string[]
): HlsAttribute[] {
    const present = modeled.filter((a): a is HlsAttribute => a !== undefined);
    const modeledByName = new Map(present.map((a) => [a.name, a]));
    const originalByName = new Map(original.map((a) => [a.name, a]));
    const modeledNameSet = new Set(modeledNames);

    const order: string[] = [];
    const seen = new Set<string>();
    for (const a of original) {
        if (!seen.has(a.name)) {
            seen.add(a.name);
            order.push(a.name);
        }
    }
    for (const name of modeledNames) {
        if (!seen.has(name)) {
            seen.add(name);
            order.push(name);
        }
    }
    for (const a of present) {
        if (!seen.has(a.name)) {
            seen.add(a.name);
            order.push(a.name);
        }
    }

    const out: HlsAttribute[] = [];
    for (const name of order) {
        const m = modeledByName.get(name);
        const o = originalByName.get(name);
        if (m) {
            out.push(o && equivalent(o, m) ? o : m);
        } else if (o && !modeledNameSet.has(name)) {
            out.push(o);
        }
    }
    return out;
}

/**
 * Pick the source text for a numeric field when it still denotes the same
 * number (`4.000000` for `4`), so `#EXTINF` durations round-trip verbatim.
 */
export function preferOriginalNumber(
    original: string | undefined,
    value: number
): string {
    if (original !== undefined && Number(original) === value) return original;
    return String(value);
}
