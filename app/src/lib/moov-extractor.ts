/**
 * Extract metadata from media files for early probing during upload.
 *
 * For MP4 (moov-at-end): extracts ftyp + moov atoms.
 * For MKV / faststart MP4 / other formats: extracts the first few MB
 * of the file (metadata is at the start).
 */

function readUint32(data: Uint8Array, offset: number): number {
    return (
        ((data[offset] << 24) >>> 0) +
        (data[offset + 1] << 16) +
        (data[offset + 2] << 8) +
        data[offset + 3]
    );
}

function readBoxType(data: Uint8Array, offset: number): string {
    return String.fromCharCode(
        data[offset + 4],
        data[offset + 5],
        data[offset + 6],
        data[offset + 7],
    );
}

/** Read 64-bit size (bytes 8-15 of the box header when 32-bit size == 1) */
function readUint64(data: Uint8Array, offset: number): number {
    // JS can handle integers up to 2^53 safely — enough for any real file
    const hi = readUint32(data, offset);
    const lo = readUint32(data, offset + 4);
    return hi * 0x1_0000_0000 + lo;
}

interface BoxInfo {
    type: string;
    offset: number;
    size: number;
}

/**
 * Scan top-level MP4 boxes by reading only their 8-16 byte headers.
 * Very fast even for multi-GB files (typically 3-5 reads).
 */
async function scanTopLevelBoxes(file: File): Promise<BoxInfo[]> {
    const boxes: BoxInfo[] = [];
    let offset = 0;

    while (offset < file.size) {
        const headerSize = 16; // enough for 64-bit extended size
        const slice = new Uint8Array(
            await file.slice(offset, Math.min(offset + headerSize, file.size)).arrayBuffer(),
        );
        if (slice.length < 8) break;

        let size = readUint32(slice, 0);
        const type = readBoxType(slice, 0);

        if (size === 1 && slice.length >= 16) {
            // 64-bit extended size
            size = readUint64(slice, 8);
        } else if (size === 0) {
            // Box extends to end of file
            size = file.size - offset;
        }

        if (size < 8) break; // Invalid box

        boxes.push({ type, offset, size });
        offset += size;
    }

    return boxes;
}

export interface MoovExtractionResult {
    /** Raw ftyp atom bytes */
    ftyp: ArrayBuffer;
    /** Raw moov atom bytes */
    moov: ArrayBuffer;
    /** Size of ftyp atom (needed for offset adjustment on server) */
    ftypSize: number;
}

/**
 * Extract moov and ftyp atoms from an MP4 file.
 *
 * Returns null if:
 * - File is not an MP4 (no ftyp box)
 * - File is already faststart (moov before mdat)
 * - moov atom not found
 */
export async function extractMoov(file: File): Promise<MoovExtractionResult | null> {
    // Need at least 8 bytes for the first box header
    if (file.size < 8) return null;

    const boxes = await scanTopLevelBoxes(file);

    const ftypBox = boxes.find((b) => b.type === 'ftyp');
    const moovBox = boxes.find((b) => b.type === 'moov');
    const mdatBox = boxes.find((b) => b.type === 'mdat');

    // Not an MP4 or no moov found
    if (!ftypBox || !moovBox) return null;

    // Already faststart: moov comes before mdat
    if (mdatBox && moovBox.offset < mdatBox.offset) return null;

    const ftyp = await file.slice(ftypBox.offset, ftypBox.offset + ftypBox.size).arrayBuffer();
    const moov = await file.slice(moovBox.offset, moovBox.offset + moovBox.size).arrayBuffer();

    return {
        ftyp,
        moov,
        ftypSize: ftypBox.size,
    };
}

/** Default size of the file header to extract */
const DEFAULT_HEADER_PROBE_SIZE = 2 * 1024 * 1024; // 2 MB

/**
 * Extract the first few MB of a file for early server-side probing.
 * Used for MKV and faststart MP4 where metadata is at the start.
 * Returns null for very small files or moov-at-end MP4 (no metadata at start).
 */
export async function extractFileHeader(file: File): Promise<ArrayBuffer | null> {
    // Only useful for files large enough that upload takes noticeable time
    if (file.size < DEFAULT_HEADER_PROBE_SIZE * 2) return null;

    if (file.size < 8) return null;

    const boxes = await scanTopLevelBoxes(file);
    const ftypBox = boxes.find((b) => b.type === 'ftyp');
    const moovBox = boxes.find((b) => b.type === 'moov');
    const mdatBox = boxes.find((b) => b.type === 'mdat');

    if (ftypBox && moovBox && mdatBox) {
        if (moovBox.offset > mdatBox.offset) {
            // Moov-at-end MP4 — no metadata at start, can't use header approach
            return null;
        }
        // Faststart MP4 — include complete ftyp + moov (don't truncate moov)
        const endOfMetadata = moovBox.offset + moovBox.size;
        return file.slice(0, endOfMetadata).arrayBuffer();
    }

    if (ftypBox && !moovBox) {
        // MP4 but couldn't find moov — skip
        return null;
    }

    // Non-MP4 (MKV, etc.) — send default header size
    return file.slice(0, DEFAULT_HEADER_PROBE_SIZE).arrayBuffer();
}
