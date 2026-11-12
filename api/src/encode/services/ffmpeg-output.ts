/**
 * What ffmpeg wrote to stderr, kept for the log when it fails.
 *
 * Its progress, the stats line and one "Opening … for writing" per segment
 * arrive many times a second, so a plain tail of the output held nothing else:
 * the line that said why the encode failed (a hardware encoder that would not
 * open, an input it could not read) was printed early and long gone. Those
 * routine lines are left out, and the start of the output is kept beside its
 * end.
 */

const HEAD_BYTES = 16 * 1024;
const TAIL_BYTES = 16 * 1024;

/** `-progress` writes `key=value`, one per line. */
const PROGRESS = /^[a-z0-9_]+=\S*$/;
/** The stats line, redrawn in place: `frame= 120 fps= 30 … speed=1.2x`. */
const STATS = /^\s*(frame|size)=\s*\S+.*\b(time|speed)=/;
/** The HLS muxer, once per segment written. */
const SEGMENT_OPENED = /^\[hls @ [^\]]+\] Opening '.*' for writing$/;

function routine(line: string): boolean {
    return PROGRESS.test(line) || STATS.test(line) || SEGMENT_OPENED.test(line);
}

export class FfmpegOutput {
    private readonly headBytes: number;
    private readonly tailBytes: number;
    private readonly head: string[] = [];
    private headSize = 0;
    private tail: string[] = [];
    private tailSize = 0;
    private dropped = 0;
    private partial = '';

    constructor(opts: { headBytes?: number; tailBytes?: number } = {}) {
        this.headBytes = opts.headBytes ?? HEAD_BYTES;
        this.tailBytes = opts.tailBytes ?? TAIL_BYTES;
    }

    /** A chunk of stderr, as it arrives; lines may be split across chunks. */
    push(chunk: string): void {
        const lines = (this.partial + chunk).split(/\r\n|\r|\n/);
        this.partial = lines.pop() ?? '';
        for (const line of lines) this.keep(line);
    }

    /** The start and the end of what ffmpeg said, routine lines left out. */
    report(): string {
        const rest =
            this.partial.trim() && !routine(this.partial) ? [this.partial] : [];
        const gap =
            this.dropped > 0 ? [`… ${this.dropped} lines left out …`] : [];
        return [...this.head, ...gap, ...this.tail, ...rest].join('\n').trim();
    }

    private keep(line: string): void {
        if (!line.trim() || routine(line)) return;
        if (
            this.headSize + line.length <= this.headBytes &&
            this.tail.length === 0
        ) {
            this.head.push(line);
            this.headSize += line.length + 1;
            return;
        }
        this.tail.push(line);
        this.tailSize += line.length + 1;
        while (this.tailSize > this.tailBytes && this.tail.length > 1) {
            this.tailSize -= this.tail.shift()!.length + 1;
            this.dropped++;
        }
    }
}
