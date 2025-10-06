import { QueueItemDto } from '../dto/queueDto';
import { getQueueFile, saveQueueFile, getFile, deleteFile } from './file';
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

    if (status === 'completed') {
        const completed = itemsForDispatch.filter(
            (item) => item.status === 'completed'
        );

        // Load file contents, then schedule removal
        const enriched: Array<QueueItemDto & { file?: File | Buffer }> = [];
        for (const item of completed) {
            try {
                if (item.filePath) {
                    const file = getFile(item.filePath) as unknown as Buffer;
                    enriched.push({ ...item, file });
                    // Delete file from disk
                    deleteFile(item.filePath);
                } else {
                    enriched.push({ ...item });
                }
            } catch (err) {
                // If file retrieval fails, still return meta without file
                enriched.push({ ...item });
            }
        }

        // Remove completed items from queue (those for this dispatchId & completed)
        if (completed.length) {
            let changed = false;
            for (let i = dispatchQueue.length - 1; i >= 0; i--) {
                const qItem = dispatchQueue[i];
                if (
                    qItem.dispatchId === dispatchId &&
                    qItem.status === 'completed'
                ) {
                    dispatchQueue.splice(i, 1);
                    changed = true;
                }
            }
            if (changed) {
                saveDispatchQueue();
            }
        }

        return enriched;
    }

    // Other statuses (pending, processing, failed, invalid)
    return itemsForDispatch.filter((item) => item.status === status);
}
