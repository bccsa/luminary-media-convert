import { QueueItemDto } from '../dto/queueDto';
import { deleteFile, createDirectory } from './file';
import { convert } from '../GstMediaConver/converter';
import { dirname } from 'path';

export async function processFile(item: QueueItemDto) {
    if (!item) {
        throw new Error('Item is invalid');
    }
    item.status = 'processing';
    console.log(`Processing file: ${item.filePath}`);

    // Determine target formats supported end-to-end by converter
    const supportedFormats = new Set([
        'mp4',
        'mov',
        'avi',
        'mkv',
        'flv',
        'wmv',
        'webm',
        'mp3',
        'wav',
        'aac',
        'ogg',
        'opus',
        'flac',
    ]);

    const targetFormat = item.metadata.convertedFormat.toLowerCase();

    if (!supportedFormats.has(targetFormat)) {
        item.status = 'failed';
        return {
            ...item,
        };
    }

    // Build destination path with the correct extension
    const originalName = item.metadata.originalName || 'output';
    const baseName = originalName.replace(/\.[^.]+$/, '');
    const destination = `processed/${item.id}-${baseName}.${targetFormat}`;

    // Ensure destination directory exists
    createDirectory(dirname(destination));

    try {
        await convert({
            source: item.filePath,
            destination,
            bitrateKbps: item.metadata.bitrate,
            format: targetFormat as any,
        });

        // Delete source after successful conversion
        deleteFile(item.filePath);

        console.log(`Completed processing file: ${destination}`);
        item.status = 'completed';
        item.filePath = destination;
        return item;
    } catch (err) {
        console.error('Conversion failed:', err);
        item.status = 'failed';
        return item;
    }
}
