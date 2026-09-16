/**
 * The MIME types the pipeline serves things as.
 *
 * All that is left of what was `blob-registry.ts`. The blob implementation has
 * moved out to the web packages, because this one is headless by contract —
 * its own vitest config says so — and a `ServeStrategy` built on
 * `URL.createObjectURL` contradicted that for as long as it lived here. What
 * remains is the part every platform agrees on: what to label the bytes.
 */

export const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
export const VTT_CONTENT_TYPE = 'text/vtt';
export const KEY_CONTENT_TYPE = 'application/octet-stream';
