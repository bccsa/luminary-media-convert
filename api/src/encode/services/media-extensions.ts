export const ALLOWED_EXTENSIONS = new Set([
    '.mp4', '.mkv', '.mov', '.avi', '.webm', '.flv', '.wmv', '.m4v', '.ts',
    '.mts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.3g2', '.mxf', '.ogv',
    '.mp3', '.aac', '.flac', '.wav', '.ogg', '.m4a', '.wma', '.opus', '.aiff',
]);

export function hasAllowedExtension(filename: string): boolean {
    const idx = filename.lastIndexOf('.');
    if (idx < 0) return false;
    const ext = filename.slice(idx).toLowerCase();
    return ALLOWED_EXTENSIONS.has(ext);
}

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
    'video/mp4': '.mp4',
    'video/quicktime': '.mov',
    'video/x-matroska': '.mkv',
    'video/webm': '.webm',
    'video/x-msvideo': '.avi',
    'video/x-flv': '.flv',
    'video/x-ms-wmv': '.wmv',
    'video/mpeg': '.mpg',
    'video/mp2t': '.ts',
    'video/3gpp': '.3gp',
    'video/3gpp2': '.3g2',
    'video/ogg': '.ogv',
    'audio/mpeg': '.mp3',
    'audio/aac': '.aac',
    'audio/flac': '.flac',
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/ogg': '.ogg',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/x-ms-wma': '.wma',
    'audio/opus': '.opus',
    'audio/aiff': '.aiff',
    'audio/x-aiff': '.aiff',
};

export function extensionFromContentType(contentType: string | null | undefined): string | null {
    if (!contentType) return null;
    const main = contentType.split(';')[0]!.trim().toLowerCase();
    return CONTENT_TYPE_TO_EXT[main] ?? null;
}
