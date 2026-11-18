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
 * The pixels can, so tiny frames are taken from every track at the same
 * instants and compared.
 *
 * Agreement and disagreement are not equal evidence. Two qualities of one
 * picture never show different things, so one disagreement that a scene cut
 * cannot explain proves two pictures. Agreement proves nothing on its own: a
 * programme feed that sits on one camera most of the time agrees with that
 * camera at almost every instant. So a pair is settled the moment it
 * disagrees, and a pair that keeps agreeing is sampled further before it is
 * believed — see {@link comparePair}.
 *
 * Pure, so it can be reasoned about without ffmpeg: the probe grabs the frames
 * and this decides what they mean.
 */

/** Sample frames are scaled to this size, greyscale, one byte per pixel. */
export const SAMPLE_WIDTH = 32;
export const SAMPLE_HEIGHT = 18;
export const SAMPLE_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT;

/** Instants sampled from every track: the first look. */
export const SAMPLE_COUNT = 8;

/**
 * Further instants sampled from the tracks of a pair that agreed at the first
 * look, before the pair is believed to be one picture.
 *
 * Agreement is weak evidence, and how weak depends on how often the tracks
 * show the same thing anyway. A programme feed on one camera 90% of the time
 * slips through 8 instants nearly half the time even when every disagreement
 * counts; through 48, under 1%. Only pairs still agreeing pay for these, so
 * two different cameras — settled at the first disagreement — cost nothing
 * more. What sampling cannot catch, a feed on one camera nearly all of the
 * time, the form flags by other means.
 */
export const VERIFY_SAMPLE_COUNT = 40;

/** Further instants taken per round, before the pairs are judged again. */
export const VERIFY_BATCH = 8;

/**
 * How far either side of a disagreement the two tracks are looked at again,
 * in milliseconds.
 *
 * Two qualities of one picture can still disagree at an instant: tracks at
 * different frame rates do not hold a frame at the same moment, and a sample
 * landing on a scene cut can catch one track either side of it. Half a second
 * either way steps clear of the cut, and of any frame offset, so tracks that
 * agree there were one picture all along. Two pictures go on disagreeing,
 * unless a cutaway was shorter than a second and centred on the instant.
 */
export const RECHECK_OFFSET_MS = 500;

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

/** Agreeing instants a pair needs before it may be called one picture. */
export const MIN_INFORMATIVE = 5;

/** Display aspect ratios further apart than this are never one picture. */
export const ASPECT_TOLERANCE = 0.02;

export interface PictureTrack extends AspectTrack {
    index: number;
}

/**
 * One track's frames, by instant in whole milliseconds on the source timeline.
 * Null where the track had no frame to give there; absent where it was not
 * asked.
 */
export type TrackFrames = ReadonlyMap<number, Uint8Array | null>;

/** What comparing two tracks has shown so far. See {@link comparePair}. */
export interface PairEvidence {
    /** Instants where at least one of the two frames had a picture. */
    informative: number;
    /** Of those, the instants where the frames showed the same picture. */
    matched: number;
    /** Disagreements the frames either side explained: a cut or frame offset. */
    explained: number;
    /**
     * A disagreement the frames either side did not explain — proof of two
     * pictures. Comparison stops at the first, so this is 0 or 1.
     */
    confirmed: number;
    /**
     * Instants not yet sampled that the earliest unexplained disagreement
     * needs looked at, from both tracks, before the pair can be judged. Empty
     * when every disagreement found so far is accounted for.
     */
    needed: number[];
}

/**
 * Compare two tracks at `instants`, re-checking each disagreement at the
 * instants `neighbours` gives for it.
 *
 * An instant either track gave no frame at is skipped, and so is one where
 * both frames are flat: every source agrees on what black looks like. One
 * where only one frame is flat is still compared, and a flat frame correlates
 * with a picture only when it is a dim copy of it — a proxy is not black while
 * its master shows a picture. See {@link framesAgree}, which judges the
 * neighbours by the same rule.
 *
 * A disagreement is looked at again either side. If the tracks agree at every
 * neighbour that has frames from both, it is explained. If they disagree at
 * any, it is confirmed and the pair is settled. Neighbours not yet sampled are
 * asked for, only for the earliest disagreement in want of them, so a pair of
 * different cameras costs one re-check, not one per instant.
 */
export function comparePair(
    a: TrackFrames,
    b: TrackFrames,
    instants: readonly number[],
    neighbours: (instant: number) => readonly number[]
): PairEvidence {
    const evidence: PairEvidence = {
        informative: 0,
        matched: 0,
        explained: 0,
        confirmed: 0,
        needed: [],
    };
    for (const instant of instants) {
        const fa = a.get(instant);
        const fb = b.get(instant);
        if (!fa || !fb) continue;
        const sa = frameStats(fa);
        const sb = frameStats(fb);
        if (sa.stdDev < FLAT_THRESHOLD && sb.stdDev < FLAT_THRESHOLD) continue;
        evidence.informative++;
        if (frameCorrelation(fa, sa, fb, sb) >= MATCH_CORRELATION) {
            evidence.matched++;
            continue;
        }

        let seen = 0;
        const missing: number[] = [];
        for (const n of neighbours(instant)) {
            const na = a.get(n);
            const nb = b.get(n);
            if (na === undefined || nb === undefined) {
                missing.push(n);
                continue;
            }
            // A track with no frame there says nothing either way.
            if (!na || !nb) continue;
            seen++;
            if (!framesAgree(na, nb)) {
                evidence.confirmed = 1;
                evidence.needed = [];
                return evidence;
            }
        }
        if (missing.length > 0) {
            if (evidence.needed.length === 0) evidence.needed = missing;
            continue;
        }
        // Nothing either side to excuse it with: it stands.
        if (seen === 0) {
            evidence.confirmed = 1;
            evidence.needed = [];
            return evidence;
        }
        evidence.explained++;
    }
    return evidence;
}

/**
 * The pair has shown that it is two pictures.
 *
 * Only a confirmed disagreement does. Explained ones are not counted against a
 * pair however many there are: tracks at frame rates that do not divide each
 * other, on fast motion, can disagree at many instants and still be one
 * picture. Two cameras framed so nearly alike that they agree a second either
 * side of every disagreement are a question for {@link MATCH_CORRELATION}.
 */
export function provenDifferent(evidence: PairEvidence): boolean {
    return evidence.confirmed > 0;
}

/**
 * The pair may be one picture on what has been compared: nothing proves two,
 * nothing is waiting to be re-checked, and enough instants agreed. Whether
 * enough instants were *compared* to believe it is the caller's question.
 */
export function stillAlike(evidence: PairEvidence): boolean {
    return (
        !provenDifferent(evidence) &&
        evidence.needed.length === 0 &&
        evidence.matched >= MIN_INFORMATIVE
    );
}

/** When a track's frames fall: its first frame and the time between, seconds. */
export interface FrameCadence {
    start: number;
    period: number;
}

/** Where on the timeline a sample is taken, and how to ask for it. */
export interface InstantAligner {
    /** The instant (ms) moved onto a frame the tracks share, where they do. */
    align(instant: number): number;
    /**
     * Where to seek for the frame at an aligned instant: seconds on the source
     * timeline, from which the first frame is the one wanted.
     */
    seekFor(instant: number): number;
}

/**
 * Sample at frames the tracks hold at the same moment.
 *
 * A seek returns a track's first frame at or after the instant asked for, and
 * tracks at different frame rates hold different frames there: at 11.25 s a
 * 50 fps track gives its frame at 11.26, a 25 fps one its frame at 11.28. On
 * fast motion, or with a cut between the two, one picture reads as two. So
 * every instant is moved onto the slowest track's frame grid — which a ladder
 * that halves its frame rate for the low rungs shares with every rung — and
 * the frame is asked for half the fastest track's frame early, so rounding to
 * a millisecond cannot push it to the next one. Where the rates do not divide
 * each other, the faster tracks give their first frame after, as before.
 *
 * Unaligned when any track's cadence is unknown.
 */
export function instantAligner(
    cadences: readonly (FrameCadence | undefined)[]
): InstantAligner {
    const unaligned: InstantAligner = {
        align: (instant) => instant,
        seekFor: (instant) => instant / 1000,
    };
    const known = cadences.filter(
        (c): c is FrameCadence =>
            c != null && Number.isFinite(c.start) && c.period > 0
    );
    if (known.length === 0 || known.length !== cadences.length)
        return unaligned;
    const grid = known.reduce((a, b) => (b.period > a.period ? b : a));
    const early = Math.min(...known.map((c) => c.period)) / 2;
    // Under a millisecond the rounding could land past the frame wanted.
    if (early < 0.001) return unaligned;
    return {
        align: (instant) =>
            Math.round(
                (grid.start +
                    Math.round((instant / 1000 - grid.start) / grid.period) *
                        grid.period) *
                    1000
            ),
        seekFor: (instant) => instant / 1000 - early,
    };
}

/**
 * The instants either side of `instant` that a disagreement there is checked
 * at, inside `start`..`end`. All three in whole milliseconds.
 */
export function recheckInstants(
    instant: number,
    start: number,
    end: number
): number[] {
    return [instant - RECHECK_OFFSET_MS, instant + RECHECK_OFFSET_MS].filter(
        (n) => n >= start && n <= end
    );
}

/**
 * Which tracks show the same picture, as a map from track index to group id.
 *
 * `alike` answers for a pair of track indices; tracks of different shapes are
 * never asked. A track joins the first group it is alike with *every* member
 * of, so a chain — A like B, B like C, but A proven unlike C — cannot pull A
 * and C into one angle. Were the evidence an exact equivalence that would make
 * no difference; it is not, and it errs here towards keeping pictures apart.
 *
 * Only tracks in a group of two or more appear. The id is the group's lowest
 * track index: an identifier, deliberately not a verdict on which member is
 * best — ranking belongs to the form, which also knows which members the
 * operator has left out, and a second ranking here could only disagree with it.
 */
export function groupPictures(
    tracks: readonly PictureTrack[],
    alike: (a: number, b: number) => boolean
): Map<number, number> {
    const same = (a: PictureTrack, b: PictureTrack) =>
        sameAspect(a, b) && alike(a.index, b.index);
    const found: PictureTrack[][] = [];
    for (const track of tracks) {
        const home = found.find((g) => g.every((m) => same(m, track)));
        if (home) home.push(track);
        else found.push([track]);
    }

    const groups = new Map<number, number>();
    for (const members of found) {
        if (members.length < 2) continue;
        const id = Math.min(...members.map((m) => m.index));
        for (const m of members) groups.set(m.index, id);
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
 * Two frames show the same thing: both flat — black, a fade — or correlated at
 * {@link MATCH_CORRELATION}. The rule a sampled instant is matched by, so a
 * dim pair either side of the flat threshold is not one picture as a sample
 * and two as a neighbour.
 */
export function framesAgree(a: Uint8Array, b: Uint8Array): boolean {
    const sa = frameStats(a);
    const sb = frameStats(b);
    if (sa.stdDev < FLAT_THRESHOLD && sb.stdDev < FLAT_THRESHOLD) return true;
    return frameCorrelation(a, sa, b, sb) >= MATCH_CORRELATION;
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
 * The instants to sample, inside the span every track covers, in whole
 * milliseconds: `count` of them, `phase` of the way into each of `count` equal
 * slices.
 *
 * Centred by default, so neither the head (slates, black) nor the very end (a
 * track that stops a frame early) is asked for a frame. The verifying round
 * takes a different count and phase, so none of its instants repeats one of
 * the first look's.
 */
export function sampleInstants(
    start: number,
    end: number,
    count = SAMPLE_COUNT,
    phase = 0.5
): number[] {
    const span = end - start;
    if (!(span > 0) || count < 1) return [];
    return Array.from({ length: count }, (_, i) =>
        Math.round(start + (span * (i + phase)) / count)
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
