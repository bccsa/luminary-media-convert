/** Parse sprite thumbnail cues from encoding API `thumbnails.vtt` (same format as Video.js thumbnail preview). */

export interface ThumbnailSpriteCue {
    startTime: number;
    endTime: number;
    spriteUrl: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

/** Parse a VTT timestamp (HH:MM:SS.mmm) to seconds. */
export function parseThumbnailVttTime(str: string): number {
    const parts = str.trim().split(':');
    if (parts.length === 3) {
        const [h, m, rest] = parts;
        const [s, ms] = rest.split('.');
        return (
            parseInt(h, 10) * 3600 +
            parseInt(m, 10) * 60 +
            parseInt(s, 10) +
            (ms ? parseInt(ms.padEnd(3, '0'), 10) / 1000 : 0)
        );
    }
    return 0;
}

/**
 * Parse WebVTT text into thumbnail cues. Resolves relative sprite paths against `baseUrl`
 * (directory containing the `.vtt` file), same as Video.js thumbnail preview.
 */
export function parseThumbnailVtt(text: string, baseUrl: string): ThumbnailSpriteCue[] {
    const cues: ThumbnailSpriteCue[] = [];
    const blocks = text.split(/\n\n+/);

    for (const block of blocks) {
        const lines = block.trim().split('\n');
        const timeLine = lines.find((l) => l.includes(' --> '));
        if (!timeLine) continue;

        const [startStr, endStr] = timeLine.split(' --> ');
        const startTime = parseThumbnailVttTime(startStr);
        const endTime = parseThumbnailVttTime(endStr);

        const payloadLine = lines[lines.indexOf(timeLine) + 1]?.trim();
        if (!payloadLine) continue;

        const [fileRef, fragment] = payloadLine.split('#');
        const spriteUrl = fileRef.startsWith('http')
            ? fileRef
            : `${baseUrl}/${fileRef}`;

        let x = 0;
        let y = 0;
        let w = 0;
        let h = 0;
        if (fragment?.startsWith('xywh=')) {
            const vals = fragment.slice(5).split(',').map(Number);
            x = vals[0] ?? 0;
            y = vals[1] ?? 0;
            w = vals[2] ?? 0;
            h = vals[3] ?? 0;
        }

        cues.push({ startTime, endTime, spriteUrl, x, y, w, h });
    }

    return cues;
}

export function findThumbnailCue(
    cues: ThumbnailSpriteCue[],
    timeSec: number,
): ThumbnailSpriteCue | undefined {
    return cues.find((c) => timeSec >= c.startTime && timeSec < c.endTime);
}
