export type SegmentEditorMode = 'trim' | 'chapters' | 'subtitles';

export interface Segment {
    /** Stable id; auto-generated if omitted by consumer */
    id: string;
    /** In-point in seconds */
    inSec: number;
    /** Out-point in seconds */
    outSec: number;
    /** Optional label — used as chapter title or subtitle text */
    label?: string;
    /** Consumer-defined passthrough data, preserved across emits */
    data?: unknown;
}

/** Create a random stable id for a new segment. */
export function createSegmentId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `seg_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}
