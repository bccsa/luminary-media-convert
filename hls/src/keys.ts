/**
 * Reduce a user-entered value (which may be a full S3 URL, a
 * bucket-qualified path, or a bare object key) to an object key
 * suitable for the S3 API.
 */
export function normalizeS3Key(input: string, bucket: string): string {
    let key = input.trim();
    if (/^https?:\/\//i.test(key)) {
        try {
            key = new URL(key).pathname;
        } catch {
            // leave as-is
        }
    }
    key = key.replace(/^\/+/, '');
    const bucketPrefix = bucket + '/';
    if (key.startsWith(bucketPrefix)) {
        key = key.slice(bucketPrefix.length);
    }
    return key;
}

/**
 * Derive a friendly angle name from a master playlist filename.
 * e.g. "prefix/main.m3u8" → "main", "prefix/audio_only.m3u8" → "audio only".
 * Falls back to "Angle N" when the filename provides no signal.
 */
export function deriveAngleName(key: string, _folderPrefix: string, index: number): string {
    const lastSlash = key.lastIndexOf('/');
    const filename = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
    const stem = filename.replace(/\.m3u8$/i, '');
    if (!stem) return `Angle ${index + 1}`;
    return stem.replace(/_/g, ' ');
}
