import { statfs } from 'fs/promises';
import { formatBytes } from './output-estimate.js';

/**
 * Free space to keep in hand on the work volume, beyond whatever is being
 * accepted right now.
 *
 * An upload that exactly fills the disk is not a success: the encode that
 * follows needs somewhere to write, and on a shared volume so does every other
 * session. Staging ran to 0 bytes free with an encode in flight, and the next
 * upload was accepted anyway — this is the headroom that stops that.
 */
export const DEFAULT_RESERVE_BYTES = 2 * 1024 ** 3;

/** The reserve, overridable per host via `DISK_RESERVE_BYTES`. */
export function reserveBytes(): number {
    const raw = parseInt(process.env.DISK_RESERVE_BYTES ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RESERVE_BYTES;
}

/** Free bytes on the volume holding `dir`, or null when it cannot be read. */
export async function freeBytes(dir: string): Promise<number | null> {
    try {
        const fs = await statfs(dir);
        return fs.bavail * fs.bsize;
    } catch {
        return null;
    }
}

/**
 * Why an incoming source of `needBytes` cannot be accepted, or null when it can
 * (or when the question cannot be answered).
 *
 * Checked before the transfer rather than after it. The encoder already refuses
 * an encode that will not fit, but that check runs once the source is on disk —
 * so a doomed upload still costs the user the entire transfer, several minutes
 * of it on a large file, before anything tells them there was never room.
 *
 * Silent when the size or the free-space reading is unavailable: a missing
 * figure is a reason to behave as before, not to refuse someone's upload.
 */
export async function ingestShortfall(
    dir: string,
    needBytes: number
): Promise<string | null> {
    if (!(needBytes > 0)) return null;

    const free = await freeBytes(dir);
    if (free === null) return null;

    const reserve = reserveBytes();
    if (free >= needBytes + reserve) return null;

    return (
        `Not enough disk space on the encoder for this file: it needs ` +
        `${formatBytes(needBytes)} and only ${formatBytes(free)} is free ` +
        `(${formatBytes(reserve)} is held in reserve for encodes already ` +
        `running). Free space on the encoder and upload again.`
    );
}
