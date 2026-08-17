/**
 * Re-exported from `@luminary-media-converter/hls`, which owns this parse now.
 *
 * The player needs the identical thing for its scrub preview, and `thumbnails.vtt`
 * is a format neither library defines — so it lives with the other sidecar
 * conventions rather than in two copies that drift. Kept as a module here
 * because it is part of this package's published surface.
 */
export {
    parseThumbnailVtt,
    parseThumbnailVttTime,
    findThumbnailCue,
    type ThumbnailSpriteCue,
} from '@luminary-media-converter/hls';
