import { ConvertDto, ConvertResponseDto } from 'src/dto/convertDto';
import { getQueueFile, saveQueueFile, saveFile } from './file';
import { QueueItemDto } from 'src/dto/queueDto';
import { v4 as uuidv4 } from 'uuid';
import dotenv from 'dotenv';
dotenv.config();

const jobQueue: Array<QueueItemDto> = [];
const queueFilePath = process.env.QUEUE_FILE_PATH || 'queue.json';

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
        };
    }
    if (!file.file) {
        return {
            id: queueId,
            status: 'invalid',
            fileName: file.metadata?.originalName || 'Unknown Name',
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
        `files/${queueItem.id}-${queueItem.metadata.originalName}`,
        file.file
    );

    jobQueue.push(queueItem);

    saveQueueFile(queueFilePath, jobQueue);
    return {
        id: queueId,
        status: queueItem.status,
        fileName: file.metadata.originalName,
    };
}

export let isProcessing = false;
function processQueue() {
    if (isProcessing) return;
    isProcessing = true;
}
