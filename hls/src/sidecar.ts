export type SidecarKind = 'subtitles' | 'chapters' | 'waveform';

/**
 * Derive the S3 key of a sidecar file relative to the master playlist's folder.
 *
 * Convention:
 *   subtitles → `<masterFolder>/subtitles/<filename>` (e.g. `en.vtt`)
 *   chapters  → `<masterFolder>/chapters.vtt` (filename is ignored)
 *   waveform  → `<masterFolder>/waveform.json` (filename is ignored)
 *
 * Mirrors the existing thumbnails layout (`<masterFolder>/thumbnails/thumbnails.vtt`).
 */
export function sidecarPath(masterKey: string, kind: SidecarKind, filename: string): string {
    const lastSlash = masterKey.lastIndexOf('/');
    const folder = lastSlash >= 0 ? masterKey.slice(0, lastSlash + 1) : '';

    if (kind === 'subtitles') {
        return `${folder}subtitles/${filename}`;
    }
    if (kind === 'waveform') {
        return `${folder}waveform.json`;
    }
    // chapters is a single file — filename arg kept for signature symmetry
    return `${folder}chapters.vtt`;
}
