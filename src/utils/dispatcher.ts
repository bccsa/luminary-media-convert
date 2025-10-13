import { QueueItemDto } from '../dto/queueDto';
import { getQueueFile, saveQueueFile, getFile, deleteFile } from './file';
import { basename } from 'path';
import dotenv from 'dotenv';
dotenv.config();

const dispatchQueue: Array<QueueItemDto> = [];
const queueFilePath = process.env.QUEUE_FILE_PATH || 'dispatchQueue.json';

export async function initDispatcher() {
    const _q: Array<QueueItemDto> = await getQueueFile(queueFilePath);
    dispatchQueue.push(..._q);
}

export function appendDispatch(item: QueueItemDto) {
    dispatchQueue.push(item);
    saveDispatchQueue();
}

async function saveDispatchQueue() {
    await saveQueueFile(queueFilePath, dispatchQueue);
}

/**
 * Retrieve dispatch queue items based on status rules:
 *  - status === 'all': return all items for dispatchId (no file content mutations / deletions)
 *  - status === 'completed': return completed items for dispatchId AND:
 *      * load file contents (Buffer) into a transient `file` field on each returned object
 *      * delete the file from disk
 *      * remove those items from the in-memory dispatchQueue
 *      * persist the modified queue
 *  - any other status: return matching items WITHOUT loading file or mutating queue
 */
export function getDispatch(
    dispatchId: string,
    status:
        | 'pending'
        | 'processing'
        | 'completed'
        | 'failed'
        | 'invalid'
        | 'all'
): Array<QueueItemDto & { file?: File | Buffer }> {
    // Helper to filter by dispatchId
    const itemsForDispatch = dispatchQueue.filter(
        (item) => item.dispatchId === dispatchId
    );

    if (status === 'all') {
        return itemsForDispatch;
    }

    // Other statuses (pending, processing, failed, invalid)
    return itemsForDispatch.filter((item) => item.status === status);
}

export function getFileForDispatch(
    dispatchId: string,
    fileId: string
): Buffer | null {
    const idx = dispatchQueue.findIndex(
        (q) => q.dispatchId === dispatchId && q.id === fileId
    );
    const item = idx >= 0 ? dispatchQueue[idx] : undefined;
    if (!item) {
        return null;
    }
    let fileContent: Buffer | null = null;
    try {
        fileContent = getFile(item.filePath);
    } catch {
        // If file cannot be read, do not mutate queue; report as not found
        return null;
    }

    // After successful read, delete file and remove from queue, then persist
    try {
        deleteFile(item.filePath);
    } catch {
        // ignore delete errors
    }
    try {
        dispatchQueue.splice(idx, 1);
        // Persist the modified queue; fire-and-forget is acceptable here
        void saveDispatchQueue();
    } catch {
        // ignore persistence errors; file content already acquired
    }

    return fileContent;
}

export function getFilenameForDispatch(
    dispatchId: string,
    fileId: string
): string | null {
    const item = dispatchQueue.find(
        (q) => q.dispatchId === dispatchId && q.id === fileId
    );
    if (!item) return null;
    return basename(item.filePath);
}
