import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

/**
 * Segments a full re-encode of `config` is expected to produce: its streams
 * times the length it keeps, in segments. A trim keeps only its ranges, so it
 * is measured by those rather than by the whole source, which would leave the
 * encrypting bar short of the end by everything cut out.
 */
export function estimateSegments(
    config: EncodeConfigDto,
    sourceDurationSec: number,
    segmentDurationSec: number
): number | undefined {
    const streams =
        (config.videoRenditions?.length ?? 0) + (config.audioGroups?.length ?? 0);
    const kept = config.trimSegments?.length
        ? config.trimSegments.reduce(
              (total, range) => total + Math.max(0, range.outSec - range.inSec),
              0
          )
        : sourceDurationSec;
    return streams > 0 && kept > 0 && segmentDurationSec > 0
        ? streams * Math.ceil(kept / segmentDurationSec)
        : undefined;
}
