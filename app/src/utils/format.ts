// Shared display formatting helpers. Keep presentation-only logic here so views
// and components render dates/sizes/relative times consistently.

const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
};

const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
};

/** Human-readable byte size, e.g. `1.5 GB`, `820.0 KB`, `512 B`. */
export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024)
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
}

/** Absolute date with time, e.g. `Jan 5, 2026, 02:30 PM`. */
export function formatDateTime(
    dateStr: string | null | undefined,
    fallback = '—',
): string {
    if (!dateStr) return fallback;
    return new Date(dateStr).toLocaleDateString(undefined, DATE_TIME_OPTIONS);
}

/** Absolute date without time, e.g. `Jan 5, 2026`. */
export function formatDate(
    dateStr: string | null | undefined,
    fallback = '—',
): string {
    if (!dateStr) return fallback;
    return new Date(dateStr).toLocaleDateString(undefined, DATE_OPTIONS);
}

/**
 * Verbose relative time, e.g. `just now`, `5 mins ago`, `3 hours ago`,
 * `2 days ago`. Falls back to an absolute date+time for future dates,
 * unparseable input, or anything older than two weeks.
 */
export function formatRelative(
    dateStr: string | null | undefined,
    fallback = '—',
): string {
    if (!dateStr) return fallback;
    const ts = new Date(dateStr).getTime();
    if (Number.isNaN(ts)) return fallback;
    const sec = Math.round((Date.now() - ts) / 1000);
    if (sec < 0) return formatDateTime(dateStr, fallback);
    if (sec < 45) return 'just now';
    if (sec < 3600) {
        const min = Math.max(1, Math.round(sec / 60));
        return `${min} min${min === 1 ? '' : 's'} ago`;
    }
    if (sec < 86400 * 2) {
        const hr = Math.round(sec / 3600);
        return `${hr} hour${hr === 1 ? '' : 's'} ago`;
    }
    if (sec < 86400 * 14) {
        const day = Math.round(sec / 86400);
        return `${day} day${day === 1 ? '' : 's'} ago`;
    }
    return formatDateTime(dateStr, fallback);
}
