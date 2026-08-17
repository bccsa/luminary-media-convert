export type SidecarKind = 'subtitles' | 'chapters' | 'waveform';

/**
 * Derive the S3 key of a sidecar file relative to the master playlist's folder.
 *
 * Convention:
 *   subtitles → `<masterFolder>/subtitles/<filename>` (e.g. `en.vtt`)
 *   chapters  → `<masterFolder>/chapters/<filename>` (e.g. `en.vtt`)
 *   waveform  → `<masterFolder>/waveform.json` (filename is ignored)
 *
 * Chapters are per-language, the same shape as subtitles — this mirrors what
 * the encoding API's chapter endpoints actually read and write
 * (`chaptersKey()` in `hls-edit.service.ts`). It used to say `chapters.vtt`
 * with the filename ignored, which no longer described any live behaviour.
 *
 * Mirrors the existing thumbnails layout (`<masterFolder>/thumbnails/thumbnails.vtt`).
 */
export function sidecarPath(masterKey: string, kind: SidecarKind, filename: string): string {
    const lastSlash = masterKey.lastIndexOf('/');
    const folder = lastSlash >= 0 ? masterKey.slice(0, lastSlash + 1) : '';

    if (kind === 'subtitles') {
        return `${folder}subtitles/${filename}`;
    }
    if (kind === 'chapters') {
        return `${folder}chapters/${filename}`;
    }
    // waveform is a single file — filename arg kept for signature symmetry
    return `${folder}waveform.json`;
}
