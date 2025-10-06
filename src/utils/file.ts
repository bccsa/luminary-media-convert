import { QueueItemDto } from '../dto/queueDto';
import {
    readFileSync,
    existsSync,
    writeFileSync,
    unlinkSync,
    mkdirSync,
    lstatSync,
} from 'fs';
import { dirname } from 'path';

export function getFile(filePath: string): File {
    if (!existsSync(filePath)) {
        throw new Error('File does not exist');
    }

    const data = readFileSync(filePath); // returns Buffer
    return data as unknown as File;
}

export async function saveFile(
    filePath: string,
    file:
        | File
        | Buffer
        | { buffer?: Buffer; arrayBuffer?: () => Promise<ArrayBuffer> }
): Promise<string> {
    const dir = dirname(filePath);
    if (!directoryExists(dir)) {
        createDirectory(dir);
    }

    try {
        let data: Buffer;
        const anyFile = file as any;
        if (anyFile && typeof anyFile.arrayBuffer === 'function') {
            data = Buffer.from(await anyFile.arrayBuffer());
        } else if (anyFile && Buffer.isBuffer(anyFile.buffer)) {
            data = anyFile.buffer as Buffer; // Multer file
        } else if (Buffer.isBuffer(file)) {
            data = file as Buffer;
        } else {
            throw new Error('Unsupported file type');
        }
        writeFileSync(filePath, data);
    } catch (err) {
        throw new Error('Failed to save file: ' + (err as Error).message);
    }
    return filePath;
}

export function saveQueueFile(filePath: string, queue: Array<QueueItemDto>) {
    try {
        writeFileSync(filePath, JSON.stringify(queue, null, 2));
    } catch (err) {
        throw new Error('Failed to save queue file: ' + (err as Error).message);
    }
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

export function copyFile(srcPath: string, destPath: string) {
    if (!existsSync(srcPath)) {
        throw new Error('Source file does not exist');
    }
    const destDir = dirname(destPath);
    if (!directoryExists(destDir)) {
        createDirectory(destDir);
    }
    const data = readFileSync(srcPath);
    writeFileSync(destPath, data);
    return destPath;
}
