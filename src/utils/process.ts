import { QueueItemDto } from '../dto/queueDto';
import { deleteFile, copyFile } from './file';

export async function processFile(item: QueueItemDto) {
    if (!item) {
        throw new Error('Item is invalid');
    }
    item.status = 'processing';
    // Implement the file processing logic here
    console.log(`Processing file: ${item.filePath}`);
    // This is a temporary solution until we implement a proper storage solution when i am done with the MVP
    copyFile(
        item.filePath,
        `processed/${item.id}-${item.metadata.originalName}`
    );
    deleteFile(item.filePath);

    console.log(`Completed processing file: ${item.filePath}`);
    item.status = 'completed';
    item.filePath = `processed/${item.id}-${item.metadata.originalName}`;

    return item;
}
