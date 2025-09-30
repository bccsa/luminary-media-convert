import { ConvertDto, ConvertResponseDto } from 'src/dto/convertDto';
import { getQueueFile, saveQueueFile, saveFile } from './file';
import { QueueItemDto } from 'src/dto/queueDto';
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
    files: Array<ConvertDto>
): Promise<Array<ConvertResponseDto>> {
    if (!files || files.length === 0) {
        throw new Error('No files provided');
    }

    const responses: Array<ConvertResponseDto> = [];

    for (const file of files) {
        if (!file) {
            responses.push({
                id: 'Unknown Id',
                status: 'invalid',
                fileName: 'Unknown Name',
            });
            continue;
        }
        if (!file.file) {
            responses.push({
                id: file.id,
                status: 'invalid',
                fileName: file.metadata?.originalName || 'Unknown Name',
            });
            continue;
        }
        const queueItem: QueueItemDto = {
            dispatchId,
            status: 'pending',
            metadata: file.metadata,
            filePath: '',
            id: file.id,
        };

        responses.push({
            id: file.id,
            status: queueItem.status,
            fileName: file.metadata.originalName,
        });

        queueItem.filePath = await saveFile(
            `files/${queueItem.id}-${queueItem.metadata.originalName}`,
            file.file
        );

        jobQueue.push(queueItem);
    }

    saveQueueFile(queueFilePath, jobQueue);
    return responses;
}

export let isProcessing = false;
function processQueue() {
    if (isProcessing) return;
    isProcessing = true;
}
