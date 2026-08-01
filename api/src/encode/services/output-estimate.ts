import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

/** Container, packing and playlist overhead on top of the raw bitrate sum. */
const OVERHEAD = 1.2;

/**
 * Roughly how much disk the output of an encode will need.
 *
 * The renditions and audio groups declare their own bitrates, so the size of
 * what is about to be written is knowable before writing any of it. That is
 * worth doing: an encode that runs out of space fails at whatever line happens
 * to touch the disk first — in practice `mkdir` on the output directory — with
 * a raw ENOSPC, after the source has already been uploaded and the job queued.
 *
 * Deliberately an over-estimate. Refusing an encode that would have just fit
 * costs a re-run; accepting one that does not fit costs the whole job, and on a
 * shared volume can take another session down with it.
 *
 * Returns 0 when there is nothing to go on, which callers should treat as
 * "cannot estimate" rather than "needs nothing".
 */
export function estimateOutputBytes(
    config: Pick<EncodeConfigDto, 'videoRenditions' | 'audioGroups'>,
    durationSec: number
): number {
    if (!(durationSec > 0)) return 0;

    const videoKbps = (config.videoRenditions ?? []).reduce(
        (sum, r) => sum + (r.videoBitrateKbps ?? 0),
        0
    );
    const audioKbps = (config.audioGroups ?? []).reduce(
        (sum, g) => sum + (g.audioBitrateKbps ?? 0),
        0
    );

    const totalKbps = videoKbps + audioKbps;
    if (totalKbps <= 0) return 0;

    return Math.round(((totalKbps * 1000) / 8) * durationSec * OVERHEAD);
}

/** `12.4 GB`, for error messages a human has to act on. */
export function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
    return `${bytes} bytes`;
}
