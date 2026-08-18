/**
 * Sprite-thumbnail cues, as the encoder writes them to `thumbnails.vtt`.
 *
 * The format is the de-facto one every player uses for scrub previews (Video.js
 * included): ordinary WebVTT whose payload is an image reference with an
 * `#xywh=` media fragment naming the crop inside a sprite sheet.
 *
 * Lives here because two very different consumers need exactly this parse — the
 * encoder's trim filmstrip in `segment-editor`, and the scrub preview in
 * `player-core` — and a second copy is how the two would come to disagree about
 * a format neither of them owns.
 */

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

/**
 * The cue covering `timeSec`, or undefined when none does.
 *
 * Binary search rather than a linear scan: a scrub asks this on every pointer
 * move, and a two-hour source has thousands of cues. Requires the cues in start
 * order, which is how {@link parseThumbnailVtt} returns them and how the
 * encoder writes them.
 */
export function findThumbnailCue(
    cues: ThumbnailSpriteCue[],
    timeSec: number,
): ThumbnailSpriteCue | undefined {
    let lo = 0;
    let hi = cues.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const cue = cues[mid]!;
        if (timeSec < cue.startTime) hi = mid - 1;
        else if (timeSec >= cue.endTime) lo = mid + 1;
        else return cue;
    }
    return undefined;
}
