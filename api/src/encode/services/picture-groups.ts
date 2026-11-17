import { displayDimensionsOf, type AspectTrack } from './aspect.js';

/**
 * Which of a source's video tracks show the same picture.
 *
 * A file with several video tracks carries one of two things, and they want
 * opposite treatment. Several *qualities* of one picture — an ABR export, a
 * master with a proxy beside it — are one camera angle whose ladder is already
 * built. Several *pictures* — two cameras in one recording — are separate
 * angles, each wanting a ladder of its own. Metadata cannot tell them apart:
 * two cameras on one switcher share a frame size, a frame rate and a duration.
 * The pixels can, so a handful of tiny frames is taken from every track at the
 * same instants and compared.
 *
 * Pure, so it can be reasoned about without ffmpeg: the probe grabs the frames
 * and this decides what they mean.
 */

/** Sample frames are scaled to this size, greyscale, one byte per pixel. */
export const SAMPLE_WIDTH = 32;
export const SAMPLE_HEIGHT = 18;
export const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;

/** Instants sampled per track. */
export const SAMPLE_COUNT = 8;

/**
 * Correlation between two frames' pixels at or above which they show one
 * picture.
 *
 * Correlation rather than a difference in grey levels, because a difference
 * has to be judged against how much there is to differ by. The first version
 * compared mean absolute difference with a fixed 8 levels, and two different
 * cameras on a dim stage — each frame only four levels of contrast — sat four
 * levels apart and were called one picture, while a proxy graded a little
 * brighter than its master sat ten apart and was called a second camera.
 * Correlation is indifferent to brightness and contrast and asks only whether
 * the two frames are light and dark in the same places.
 *
 * Still a starting point, not a measurement: encodes of one picture measured
 * 0.99 and up on test patterns, different pictures under 0.3. Set high, because
 * the two mistakes are not equally bad — one picture split into two angles
 * costs an encode, two cameras merged into one publishes a ladder that changes
 * camera when it changes quality. Tune it on real recordings.
 */
export const MATCH_CORRELATION = 0.95;

/**
 * Standard deviation, in grey levels, below which a frame is flat: black, a
 * fade, a title card's background. Every source agrees on what black looks
 * like, so a flat pair proves nothing and is not counted either way.
 */
export const FLAT_THRESHOLD = 3;

/** Informative instants a pair needs before it may be called one picture. */
export const MIN_INFORMATIVE = 5;

/**
 * Informative instants a matching pair may still disagree on. One, because
 * tracks at different frame rates do not hold a frame at the same instant, and
 * a sample landing on a scene cut can catch one track either side of it.
 */
export const MAX_MISMATCHES = 1;

/** Display aspect ratios further apart than this are never one picture. */
export const ASPECT_TOLERANCE = 0.02;

export interface PictureTrack extends AspectTrack {
    index: number;
}

/**
 * One track's frames, one entry per sampled instant, in the same order for
 * every track. Null where the track had no frame to give there.
 */
export type TrackSamples = readonly (Uint8Array | null)[];

/**
 * Which tracks show the same picture, as a map from track index to group id.
 *
 * Only tracks in a group of two or more appear. The id is the group's lowest
 * track index: an identifier, deliberately not a verdict on which member is
 * best — ranking belongs to the form, which also knows which members the
 * operator has left out, and a second ranking here could only disagree with it.
 */
export function groupPictures(
    tracks: readonly PictureTrack[],
    samples: ReadonlyMap<number, TrackSamples>
): Map<number, number> {
    const parent = new Map<number, number>();
    const find = (i: number): number => {
        let root = i;
        while (parent.get(root)! !== root) root = parent.get(root)!;
        parent.set(i, root);
        return root;
    };
    for (const t of tracks) parent.set(t.index, t.index);

    for (let a = 0; a < tracks.length; a++) {
        for (let b = a + 1; b < tracks.length; b++) {
            const ta = tracks[a];
            const tb = tracks[b];
            if (!sameAspect(ta, tb)) continue;
            const sa = samples.get(ta.index);
            const sb = samples.get(tb.index);
            if (!sa || !sb) continue;
            if (!samePicture(sa, sb)) continue;
            const ra = find(ta.index);
            const rb = find(tb.index);
            if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
        }
    }

    const members = new Map<number, number[]>();
    for (const t of tracks) {
        const root = find(t.index);
        if (!members.has(root)) members.set(root, []);
        members.get(root)!.push(t.index);
    }

    const groups = new Map<number, number>();
    for (const list of members.values()) {
        if (list.length < 2) continue;
        const id = Math.min(...list);
        for (const index of list) groups.set(index, id);
    }
    return groups;
}

/** The two tracks are shown at the same shape, within {@link ASPECT_TOLERANCE}. */
export function sameAspect(a: AspectTrack, b: AspectTrack): boolean {
    const da = displayDimensionsOf(a);
    const db = displayDimensionsOf(b);
    if (!(da.width > 0 && da.height > 0 && db.width > 0 && db.height > 0))
        return false;
    const ra = da.width / da.height;
    const rb = db.width / db.height;
    return Math.abs(ra - rb) / Math.max(ra, rb) <= ASPECT_TOLERANCE;
}

/**
 * Two tracks' samples show one picture: enough informative instants, and all
 * but {@link MAX_MISMATCHES} of them correlated at {@link MATCH_CORRELATION}.
 *
 * An instant where both frames are flat is skipped. One where only one is flat
 * counts against the pair: a proxy is not black while its master shows a
 * picture.
 */
export function samePicture(a: TrackSamples, b: TrackSamples): boolean {
    let informative = 0;
    let mismatches = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const fa = a[i];
        const fb = b[i];
        if (!fa || !fb) continue;
        const sa = frameStats(fa);
        const sb = frameStats(fb);
        if (sa.stdDev < FLAT_THRESHOLD && sb.stdDev < FLAT_THRESHOLD) continue;
        informative++;
        if (frameCorrelation(fa, sa, fb, sb) < MATCH_CORRELATION) mismatches++;
        if (mismatches > MAX_MISMATCHES) return false;
    }
    return informative >= MIN_INFORMATIVE;
}

export interface FrameStats {
    mean: number;
    stdDev: number;
}

/**
 * Pearson correlation of two frames' pixels, -1 to 1: 1 when they are light and
 * dark in the same places, whatever their brightness or contrast. 0 when
 * either frame has no contrast to correlate.
 */
export function frameCorrelation(
    a: Uint8Array,
    statsA: FrameStats,
    b: Uint8Array,
    statsB: FrameStats
): number {
    const n = Math.min(a.length, b.length);
    if (n === 0 || statsA.stdDev === 0 || statsB.stdDev === 0) return 0;
    let covariance = 0;
    for (let i = 0; i < n; i++) {
        covariance += (a[i] - statsA.mean) * (b[i] - statsB.mean);
    }
    return covariance / n / (statsA.stdDev * statsB.stdDev);
}

export function frameStats(frame: Uint8Array): FrameStats {
    const n = frame.length;
    if (n === 0) return { mean: 0, stdDev: 0 };
    let sum = 0;
    for (let i = 0; i < n; i++) sum += frame[i];
    const mean = sum / n;
    let variance = 0;
    for (let i = 0; i < n; i++) variance += (frame[i] - mean) ** 2;
    return { mean, stdDev: Math.sqrt(variance / n) };
}

/**
 * The instants to sample, inside the span every track covers.
 *
 * Centred in eight equal slices, so neither the head (slates, black) nor the
 * very end (a track that stops a frame early) is asked for a frame.
 */
export function sampleInstants(start: number, end: number): number[] {
    const span = end - start;
    if (!(span > 0)) return [];
    return Array.from(
        { length: SAMPLE_COUNT },
        (_, i) =>
            Math.round((start + (span * (i + 0.5)) / SAMPLE_COUNT) * 1000) /
            1000
    );
}

/**
 * Two tracks cut keyframes at the same instants, within `tolerance` seconds.
 *
 * Both lists are keyframe times from the same sampled windows. Only the stretch
 * both lists cover is compared — a window edge can catch one track's keyframe
 * and not the other's — and every keyframe there must have a partner. Copying a
 * ladder rung by rung only works when every rung can be cut at the same
 * boundaries, so a player stepping between them lands on a segment that starts
 * where the one it left ended.
 *
 * At least two keyframes have to be compared, or a single shared one would
 * stand in for a grid nobody looked at.
 */
export function keyframesAligned(
    a: readonly number[],
    b: readonly number[],
    tolerance: number
): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const from = Math.max(a[0], b[0]) - tolerance;
    const to = Math.min(a[a.length - 1], b[b.length - 1]) + tolerance;
    const inA = a.filter((t) => t >= from && t <= to);
    const inB = b.filter((t) => t >= from && t <= to);
    if (inA.length < 2 || inA.length !== inB.length) return false;
    const hasPartner = (t: number, list: readonly number[]) =>
        list.some((u) => Math.abs(u - t) <= tolerance);
    return (
        inA.every((t) => hasPartner(t, inB)) &&
        inB.every((t) => hasPartner(t, inA))
    );
}

/**
 * The tracks of the default angle — the one holding track 0, which is first in
 * every angle ordering — when the probe detected angles; every track otherwise.
 *
 * For whatever shows the source before it is encoded: the trim preview and the
 * storyboard. On a multi-angle source they must show one camera, or the preview
 * changes picture when it changes quality and the timeline shows a camera the
 * player does not open on. A session probed before detection has no grouping to
 * go by, and keeps the tracks — and the cached storyboard — it always had.
 */
export function defaultAngleTracks<
    T extends { index: number; pictureGroup?: number },
>(probe: { videoTracks: readonly T[]; anglesDetected?: boolean }): T[] {
    const tracks = [...probe.videoTracks];
    if (!probe.anglesDetected || tracks.length < 2) return tracks;
    const first = Math.min(...tracks.map((t) => t.pictureGroup ?? t.index));
    return tracks.filter((t) => (t.pictureGroup ?? t.index) === first);
}

/**
 * Which tracks share a keyframe grid, as a map from track index to grid id —
 * the lowest track index on that grid. Every track gets one; a track alone on
 * its grid gets its own index.
 *
 * `aligned` is asked of pairs and taken to be an equivalence, so each track is
 * compared with one member of each grid found so far rather than with all of
 * them. `tracks` must be in ascending order for the id to be the lowest index.
 */
export function keyframeGrids(
    tracks: readonly number[],
    aligned: (a: number, b: number) => boolean
): Map<number, number> {
    const grids: number[][] = [];
    for (const index of tracks) {
        const home = grids.find((g) => aligned(g[0], index));
        if (home) home.push(index);
        else grids.push([index]);
    }
    const ids = new Map<number, number>();
    for (const grid of grids) for (const index of grid) ids.set(index, grid[0]);
    return ids;
}
