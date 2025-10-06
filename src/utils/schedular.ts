import { ConvertDto, ConvertResponseDto } from '../dto/convertDto';
import { getQueueFile, saveQueueFile, saveFile } from './file';
import { appendDispatch } from './dispatcher';
import { processFile } from './process';
import { QueueItemDto } from '../dto/queueDto';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

export const jobQueue: Array<QueueItemDto> = [];
const queueFilePath = process.env.QUEUE_FILE_PATH || 'jobQueue.json';

export async function initScheduler() {
    const _q: Array<QueueItemDto> = await getQueueFile(queueFilePath);
    jobQueue.push(..._q);
    setInterval(processQueue, 5000);
}

export async function queue(
    dispatchId: string,
    file: ConvertDto
): Promise<ConvertResponseDto> {
    const queueId = uuidv4();
    if (!file) {
        return {
            id: queueId,
            status: 'invalid',
            fileName: 'Unknown Name',
            error: 'No file object provided',
        };
    }
    if (!file.file) {
        return {
            id: queueId,
            status: 'invalid',
            fileName: file.metadata?.originalName || 'Unknown Name',
            error: 'File content is empty',
        };
    }

    const queueItem: QueueItemDto = {
        dispatchId,
        status: 'pending',
        metadata: file.metadata,
        filePath: '',
        id: queueId,
    };

    queueItem.filePath = await saveFile(
        `files/${queueId}-${queueItem.metadata.originalName}`,
        file.file
    );

    jobQueue.push(queueItem);

    saveQueueFile(queueFilePath, jobQueue);
    return {
        id: queueId,
        status: queueItem.status,
        fileName: file.metadata.originalName || 'Unknown Name',
    };
}

let isProcessing = false;
async function processQueue() {
    if (isProcessing) return;
    isProcessing = true;
    try {
        const job = jobQueue[0];
        if (!job) return;

        // Mark as processing if it was pending
        if (job.status === 'pending') {
            job.status = 'processing';
            await saveQueueFile(queueFilePath, jobQueue);
        }

        // Process (processFile should return an updated QueueItemDto)
        const processedItem = await processFile(job);

        jobQueue.shift(); // Remove the processed item from the queue
        appendDispatch(processedItem);

        await saveQueueFile(queueFilePath, jobQueue);
    } catch (err) {
        console.error('Error processing queue:', err);
    } finally {
        isProcessing = false;
    }
}
