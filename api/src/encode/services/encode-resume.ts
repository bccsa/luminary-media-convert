/**
 * What a failed encode leaves behind for a later run to continue from.
 *
 * Kept beside the session's output, never inside it: the output directory is
 * cleared on every failure and every restart, and what is in storage is the
 * only thing a continued encode trusts. Three files:
 *
 * - `resume/state.json`: the run it describes: its attempt number, the IV its
 *   segments were encrypted with, and fingerprints of everything that has to be
 *   unchanged for those segments to be reused.
 * - `resume/segments.jsonl`: one line per video segment seen (with its start
 *   time) and per segment known to be in storage, appended as they happen.
 * - `resume/inits/<stream>/`: each video stream's init segment, which the
 *   segments already in storage need to play.
 *
 * Pure apart from the file reads and writes, so the decisions are testable.
 */
import { createHash } from 'crypto';
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import {
    buildMediaPlaylist,
    parseMediaPlaylist,
} from '@luminary-media-converter/hls-core';
import type { DurableSegment } from './segment-pipeline.service.js';

export const RESUME_DIR = 'resume';
const STATE_FILE = 'state.json';
const SEGMENTS_FILE = 'segments.jsonl';
export const INITS_DIR = 'inits';
export const WAVES_DIR = 'waves';

/** Who ran, and with what, so a continue can tell it would be the same encode. */
export interface ResumeState {
    /** Counted from 0; chunks of attempt n > 0 are named `<chain>_r<n>_<i>.m4s`. */
    attempt: number;
    /** Everything about the config that decides the output's bytes. */
    configHash: string;
    /** The IV every segment of the encode is encrypted with; absent when not encrypted. */
    ivHex?: string;
    /** A hash of the key, never the key itself. */
    keyFingerprint?: string;
    source: { size: number; mtimeMs: number };
    /** The source head the encode seeks past, in seconds. */
    alignmentOffset: number;
    /** The video stream directories the encode writes. */
    videoStreams: string[];
    segmentDuration: number;
}

/** One line of `segments.jsonl`. */
export type ResumeRecord =
    | { kind: 'seen'; stream: string; index: number; tfdt: number }
    | ({ kind: 'durable' } & DurableSegment)
    /** A wave of a ladder in waves finished, writing this many segments per stream. */
    | { kind: 'waveDone'; wave: number; counts: Record<string, number> };

/** Where a continue restarts the video, and what it reuses. */
export interface ResumePoint {
    /** The first segment number to encode again; 0..startIndex-1 are reused. */
    startIndex: number;
    /** Per video stream: segment startIndex's start, in its track's ticks. */
    startTfdt: Record<string, number>;
    /** Per video stream: the reused segments, in order, each with the next one's start. */
    reused: Record<string, ReusedSegment[]>;
}

export interface ReusedSegment extends DurableSegment {
    tfdt: number;
    /** When the segment after it starts, for its duration. */
    nextTfdt: number;
}

export const fingerprint = (value: string): string =>
    createHash('sha256').update(value).digest('hex');

/** A stable hash of a JSON-able value: keys sorted, so property order cannot change it. */
export function stableHash(value: unknown): string {
    const sort = (v: unknown): unknown =>
        Array.isArray(v)
            ? v.map(sort)
            : v && typeof v === 'object'
              ? Object.fromEntries(
                    Object.keys(v as object)
                        .sort()
                        .map((k) => [
                            k,
                            sort((v as Record<string, unknown>)[k]),
                        ])
                )
              : v;
    return fingerprint(JSON.stringify(sort(value)));
}

/**
 * The restart point the records allow, or null when there is nothing worth
 * continuing from.
 *
 * Segments 0..K-1 of every video stream must be in storage, without a gap,
 * and segment K's start has to be known in every stream, because that is where
 * the video restarts. K is the smallest such count across the streams: one run
 * of ffmpeg encodes all of them, from one seek.
 */
export function resumePoint(
    videoStreams: string[],
    records: ResumeRecord[]
): ResumePoint | null {
    if (videoStreams.length === 0) return null;
    const seen = new Map<string, Map<number, number>>();
    const durable = new Map<string, Map<number, DurableSegment>>();
    for (const r of records) {
        if (r.kind === 'seen') {
            if (!seen.has(r.stream)) seen.set(r.stream, new Map());
            seen.get(r.stream)!.set(r.index, r.tfdt);
        } else if (r.kind === 'durable') {
            if (!durable.has(r.stream)) durable.set(r.stream, new Map());
            durable.get(r.stream)!.set(r.index, r);
        }
    }

    let k = Infinity;
    for (const stream of videoStreams) {
        const stored = durable.get(stream) ?? new Map();
        let count = 0;
        while (stored.has(count)) count++;
        k = Math.min(k, count);
    }
    // Back off until segment K's start is known everywhere, and every reused
    // segment's start is too.
    const startOf = (stream: string, index: number) =>
        seen.get(stream)?.get(index);
    const usable = (n: number) =>
        videoStreams.every((s) => {
            for (let i = 0; i <= n; i++)
                if (startOf(s, i) === undefined) return false;
            return true;
        });
    while (k > 0 && !usable(k)) k--;
    if (!Number.isFinite(k) || k < 1) return null;

    const startTfdt: Record<string, number> = {};
    const reused: Record<string, ReusedSegment[]> = {};
    for (const stream of videoStreams) {
        startTfdt[stream] = startOf(stream, k)!;
        reused[stream] = Array.from({ length: k }, (_, i) => ({
            ...durable.get(stream)!.get(i)!,
            tfdt: startOf(stream, i)!,
            nextTfdt: startOf(stream, i + 1)!,
        }));
    }
    return { startIndex: k, startTfdt, reused };
}

/** One run of ffmpeg, as `FfmpegService.waveLayout` describes it. */
export interface ResumeWave {
    videoStreams: string[];
    audioStreams: string[];
}

/** What a continued encode skips and where it restarts. */
export interface ResumePlan {
    /** Waves 0..skip-1 are wholly in storage and are not run again. */
    skip: number;
    /** Where wave `skip` restarts; null runs it from the start. */
    point: ResumePoint | null;
}

/**
 * How a failed encode continues, or null when it would only start over.
 *
 * A wave is skipped when it finished and every segment of every stream it
 * wrote is in storage. The first wave that is not restarts where its video
 * streams allow; the waves after it run again. A single run is a ladder of one
 * wave, which never finishes before failing, so only its restart point counts.
 */
export function resumePlan(
    waves: ResumeWave[],
    records: ResumeRecord[]
): ResumePlan | null {
    const stored = new Map<string, Set<number>>();
    const done = new Map<number, Record<string, number>>();
    for (const r of records) {
        if (r.kind === 'durable') {
            if (!stored.has(r.stream)) stored.set(r.stream, new Set());
            stored.get(r.stream)!.add(r.index);
        } else if (r.kind === 'waveDone') {
            done.set(r.wave, r.counts);
        }
    }
    const complete = (index: number) => {
        const counts = done.get(index);
        if (!counts) return false;
        const wave = waves[index]!;
        return [...wave.videoStreams, ...wave.audioStreams].every((stream) => {
            const count = counts[stream];
            if (!(count > 0)) return false;
            for (let i = 0; i < count; i++) {
                if (!stored.get(stream)?.has(i)) return false;
            }
            return true;
        });
    };

    let skip = 0;
    while (skip < waves.length && complete(skip)) skip++;
    const point =
        skip < waves.length
            ? resumePoint(waves[skip]!.videoStreams, records)
            : null;
    return skip === 0 && !point ? null : { skip, point };
}

/**
 * A skipped wave's playlist for one stream: the one ffmpeg wrote when the wave
 * finished, its segments pointed at where they are in storage. Without byte
 * ranges a segment is its own object, under the name the playlist already has.
 */
export function restorePlaylist(
    ffmpegPlaylist: string,
    stream: string,
    records: ResumeRecord[],
    byteRange: boolean
): string {
    const playlist = parseMediaPlaylist(ffmpegPlaylist);
    if (!byteRange) return buildMediaPlaylist(playlist);
    const where = new Map<string, DurableSegment>();
    for (const r of records) {
        if (r.kind === 'durable' && r.stream === stream) where.set(r.file, r);
    }
    for (const segment of playlist.segments) {
        const record = where.get(segment.uri);
        if (!record || record.offset === undefined) {
            throw new Error(`${stream}: ${segment.uri} is not in storage`);
        }
        segment.uri = `../${record.mediaFile}`;
        segment.byteRange = { offset: record.offset, length: record.length };
    }
    return buildMediaPlaylist(playlist);
}

/**
 * Why `previous` cannot be continued by a run described by `next`, or null
 * when it can. Every reason is a full re-encode, never a refusal.
 */
export function resumeRefusal(
    previous: ResumeState | null,
    next: Omit<ResumeState, 'attempt' | 'ivHex'>
): string | null {
    if (!previous) return 'no earlier run to continue';
    if (previous.configHash !== next.configHash) return 'the settings changed';
    if (previous.keyFingerprint !== next.keyFingerprint)
        return 'the encryption key changed';
    if (
        previous.source.size !== next.source.size ||
        previous.source.mtimeMs !== next.source.mtimeMs
    ) {
        return 'the source file changed';
    }
    if (previous.alignmentOffset !== next.alignmentOffset)
        return 'the source alignment changed';
    if (previous.segmentDuration !== next.segmentDuration)
        return 'the segment length changed';
    if (previous.videoStreams.join('\n') !== next.videoStreams.join('\n')) {
        return 'the video renditions changed';
    }
    return null;
}

/** The files of one session's resume state. */
export class ResumeStore {
    constructor(private readonly sessionDir: string) {}

    get dir(): string {
        return join(this.sessionDir, RESUME_DIR);
    }

    initsDir(stream: string): string {
        return join(this.dir, INITS_DIR, stream);
    }

    /** Where a finished wave's playlists are kept: its master, and one per stream. */
    waveDir(index: number): string {
        return join(this.dir, WAVES_DIR, String(index));
    }

    async readState(): Promise<ResumeState | null> {
        try {
            return JSON.parse(
                await readFile(join(this.dir, STATE_FILE), 'utf8')
            ) as ResumeState;
        } catch {
            return null;
        }
    }

    /** Every record, skipping a line a crash left half-written. */
    readRecords(): ResumeRecord[] {
        const path = join(this.dir, SEGMENTS_FILE);
        if (!existsSync(path)) return [];
        const out: ResumeRecord[] = [];
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line) continue;
            try {
                out.push(JSON.parse(line) as ResumeRecord);
            } catch {
                // The last line of a run that died mid-write.
            }
        }
        return out;
    }

    /** Start afresh for a run that cannot continue an earlier one. */
    async reset(state: ResumeState): Promise<void> {
        await rm(this.dir, { recursive: true, force: true });
        await mkdir(this.dir, { recursive: true });
        await writeFile(join(this.dir, STATE_FILE), JSON.stringify(state));
    }

    /** Carry on from an earlier run: its records stay, the attempt moves on. */
    async continueWith(state: ResumeState): Promise<void> {
        await mkdir(this.dir, { recursive: true });
        await writeFile(join(this.dir, STATE_FILE), JSON.stringify(state));
    }

    /**
     * Synchronous, so a record is on disk before the next one is made and a
     * crash loses at most the line being written.
     */
    append(records: ResumeRecord[]): void {
        if (records.length === 0) return;
        appendFileSync(
            join(this.dir, SEGMENTS_FILE),
            records.map((r) => JSON.stringify(r)).join('\n') + '\n'
        );
    }

    async clear(): Promise<void> {
        await rm(this.dir, { recursive: true, force: true });
    }
}
