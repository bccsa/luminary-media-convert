/** One line of words, timed, as the now-playing screen shows them. */
export interface LyricCue {
    start: number;
    end: number;
    text: string;
}

/** A cue as a text track holds it: a `VTTCue`, or a plain object standing in for one. */
interface TimedText {
    startTime: number;
    endTime: number;
    text: string;
}

/** The words of a cue without WebVTT's markup (voice, italics, classes), each line trimmed. */
export function lyricText(raw: string): string {
    return raw
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

/**
 * A track's cues as lyrics: in time order, without the empty ones, and without a cue repeated at the same time,
 * which a stream's subtitle segments carry where they overlap.
 */
export function cuesToLyrics(cues: ArrayLike<TimedText> | null | undefined): LyricCue[] {
    if (!cues) return [];
    const lines: LyricCue[] = [];
    for (const cue of Array.from(cues)) {
        const text = lyricText(cue.text ?? '');
        if (text) lines.push({ start: cue.startTime, end: cue.endTime, text });
    }
    lines.sort((a, b) => a.start - b.start);
    return lines.filter((line, i) => {
        const before = lines[i - 1];
        return !before || line.start !== before.start || line.text !== before.text;
    });
}

/**
 * The line being sung at `time`: the last one that has started. It stays lit through the pause after it until the
 * next begins, so the eye does not lose its place; -1 before the first.
 */
export function activeLyric(lines: readonly LyricCue[], time: number): number {
    let found = -1;
    for (const [i, line] of lines.entries()) {
        if (line.start > time) break;
        found = i;
    }
    return found;
}
