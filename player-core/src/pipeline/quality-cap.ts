/**
 * Load-time quality capping.
 *
 * Capping happens in the playlist, not in the engine: the munged master simply
 * omits renditions above the cap, so neither ABR nor a manual selection can
 * ever exceed it. Changing the cap therefore requires a new `load()` — that is
 * the documented contract (`PlayerSource.maxHeight`), not a limitation.
 */

import type { Quality } from '../types.js';
import {
    MODELED_GROUP_ATTRS,
    filterMasterText,
    parseMasterText,
    type MasterVariantEntry,
} from './playlist-text.js';

/**
 * Drop every variant above `maxHeight`.
 *
 * Rules:
 * - variants with `height <= maxHeight` are kept;
 * - variants with no `RESOLUTION` always survive (audio-only renditions, and
 *   anything whose height we cannot judge);
 * - when nothing qualifies, the single lowest-height variant is kept so there
 *   is always something to play;
 * - `#EXT-X-MEDIA` entries are garbage-collected down to exactly the
 *   `GROUP-ID`s still referenced by a surviving variant, so no `AUDIO=` /
 *   `VIDEO=` / `SUBTITLES=` reference is ever orphaned. A `TYPE` no variant
 *   attribute can name (`CLOSED-CAPTIONS`, which the model carries through but
 *   does not read) is left alone rather than guessed at.
 *
 * Returns the input unchanged (identity, `===`) when nothing is dropped, which
 * the pipeline uses to decide whether the master still needs munging at all.
 */
export function applyQualityCap(
    masterText: string,
    maxHeight?: number,
): string {
    if (!maxHeight || maxHeight <= 0) return masterText;

    const parsed = parseMasterText(masterText);
    if (parsed.variants.length === 0) return masterText;

    const withHeight = parsed.variants.filter((v) => v.height !== undefined);
    if (withHeight.length === 0) return masterText;

    const qualifying = withHeight.filter((v) => (v.height ?? 0) <= maxHeight);
    const keptHeighted =
        qualifying.length > 0 ? qualifying : [lowest(withHeight)];

    const keep = new Set<MasterVariantEntry>([
        ...keptHeighted,
        ...parsed.variants.filter((v) => v.height === undefined),
    ]);
    if (keep.size === parsed.variants.length) return masterText;

    // Group ids still referenced, per rendition-group attribute.
    const referenced = new Map<string, Set<string>>(
        MODELED_GROUP_ATTRS.map((attr) => [attr, new Set<string>()]),
    );
    for (const variant of keep) {
        for (const attr of MODELED_GROUP_ATTRS) {
            const groupId = variant.groups[attr];
            if (groupId) referenced.get(attr)?.add(groupId);
        }
    }

    return filterMasterText(parsed, {
        variant: (v) => keep.has(v),
        media: (m) => {
            const known = referenced.get(m.type);
            // A TYPE no variant can reference (or a media line with no
            // GROUP-ID) is left alone rather than guessed at.
            if (!known || !m.groupId) return true;
            return known.has(m.groupId);
        },
    });
}

/**
 * The selectable renditions of a (already capped) master, in descending
 * quality order. Ids follow the contract: `String(height)` for video,
 * `b<bandwidth>` for resolution-less variants.
 */
export function listQualities(masterText: string): Quality[] {
    const parsed = parseMasterText(masterText);
    const byId = new Map<string, Quality>();

    for (const variant of parsed.variants) {
        const quality = toQuality(variant.height, variant.bandwidth);
        const existing = byId.get(quality.id);
        if (!existing || existing.bandwidth < quality.bandwidth) {
            byId.set(quality.id, quality);
        }
    }

    return sortQualities([...byId.values()]);
}

/** Build the contract-shaped {@link Quality} for a height/bandwidth pair. */
export function toQuality(
    height: number | undefined,
    bandwidth: number,
): Quality {
    if (height === undefined) {
        return {
            id: `b${bandwidth}`,
            bandwidth,
            label:
                bandwidth > 0
                    ? `${Math.round(bandwidth / 1000)} kbps`
                    : 'Audio',
        };
    }
    return { id: String(height), height, bandwidth, label: `${height}p` };
}

/** Highest quality first; resolution-less variants last. */
export function sortQualities(qualities: Quality[]): Quality[] {
    return [...qualities].sort((a, b) => {
        if (a.height !== undefined && b.height !== undefined) {
            return b.height - a.height || b.bandwidth - a.bandwidth;
        }
        if (a.height !== undefined) return -1;
        if (b.height !== undefined) return 1;
        return b.bandwidth - a.bandwidth;
    });
}

function lowest(variants: MasterVariantEntry[]): MasterVariantEntry {
    return variants.reduce((best, candidate) =>
        (candidate.height ?? 0) < (best.height ?? 0) ? candidate : best,
    );
}
