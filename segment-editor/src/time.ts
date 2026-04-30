/** Format seconds as `M:SS.mmm` (or `H:MM:SS.mmm` when ≥ 1h) for display in the editor. */
export function formatTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
    }
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/** Format a duration as human readable (e.g., `2m 15s`, `45.3s`). */
export function formatDuration(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '0s';
    if (sec < 60) return `${sec.toFixed(1)}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
}

/** Parse `HH:MM:SS.mmm` or `M:SS.mmm` into seconds, or `null` if invalid. */
export function parseTime(input: string): number | null {
    const parts = input.trim().split(':');
    if (parts.length < 1 || parts.length > 3) return null;
    let h = 0, m = 0, s: number;
    if (parts.length === 3) {
        h = parseInt(parts[0], 10);
        m = parseInt(parts[1], 10);
        s = parseFloat(parts[2]);
    } else if (parts.length === 2) {
        m = parseInt(parts[0], 10);
        s = parseFloat(parts[1]);
    } else {
        s = parseFloat(parts[0]);
    }
    if (isNaN(h) || isNaN(m) || isNaN(s)) return null;
    return h * 3600 + m * 60 + s;
}
