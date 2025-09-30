import { QueueItemDto } from 'src/dto/queueDto';
import {
    readFileSync,
    existsSync,
    writeFileSync,
    unlinkSync,
    mkdirSync,
    lstatSync,
} from 'fs';

export function getFile(filePath: string): File {
    if (!existsSync(filePath)) {
        throw new Error('File does not exist');
    }

    const data = readFileSync(filePath); // returns Buffer
    return data as unknown as File;
}

export async function saveFile(
    filePath: string,
    file: Buffer
): Promise<string> {
    writeFileSync(filePath, file);
    return filePath;
}

export function saveQueueFile(filePath: string, queue: Array<QueueItemDto>) {
    writeFileSync(filePath, JSON.stringify(queue, null, 2));
}

export function getQueueFile(filePath: string): Array<QueueItemDto> {
    if (!existsSync(filePath)) {
        return [];
    }

    const data = readFileSync(filePath, 'utf-8');
    return JSON.parse(data) as Array<QueueItemDto>;
}

export function deleteFile(filePath: string) {
    if (existsSync(filePath)) {
        unlinkSync(filePath);
        return true;
    }
    return false;
}

export function createDirectory(dirPath: string) {
    if (!existsSync(dirPath)) {
        mkdirSync(dirPath, { recursive: true });
        return true;
    }
    return false;
}

export function directoryExists(dirPath: string): boolean {
    return existsSync(dirPath) && lstatSync(dirPath).isDirectory();
}
