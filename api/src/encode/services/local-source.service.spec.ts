import {
    mkdtempSync,
    rmSync,
    existsSync,
    writeFileSync,
    mkdirSync,
    symlinkSync,
    readdirSync,
    realpathSync,
} from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { LocalSourceService } from './local-source.service.js';
import { SessionService } from './session.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

function makeConfig(opts: { withWebhook?: boolean } = {}): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test',
            accessKey: 'key',
            secretKey: 'secret',
        },
        ...(opts.withWebhook
            ? {
                  webhook: {
                      url: 'https://example.com/webhook',
                      sessionToken: 'tok',
                  },
              }
            : {}),
    } as CreateSessionDto;
}

describe('LocalSourceService', () => {
    let workDir: string;
    let mediaDir: string;
    let sessionService: SessionService;
    let tusUploadService: { finalizeUpload: ReturnType<typeof vi.fn> };
    let webhookService: { send: ReturnType<typeof vi.fn> };

    /** Constructed after env tweaks — the service reads env in its constructor. */
    function makeService(): LocalSourceService {
        return new LocalSourceService(
            sessionService,
            tusUploadService as any,
            webhookService as any,
        );
    }

    function makeSession(): string {
        return sessionService.create(makeConfig()).id;
    }

    function writeMedia(name: string, bytes = 1024): string {
        const path = join(mediaDir, name);
        writeFileSync(path, Buffer.alloc(bytes, 1));
        return path;
    }

    beforeEach(() => {
        // realpathSync because the service canonicalises before comparing, and
        // on macOS tmpdir() sits under /var — a symlink to /private/var.
        workDir = realpathSync(mkdtempSync(join(tmpdir(), 'local-source-work-')));
        // A separate tree standing in for the user's own files.
        mediaDir = realpathSync(
            mkdtempSync(join(tmpdir(), 'local-source-media-')),
        );

        process.env.WORK_DIR = workDir;
        process.env.ALLOW_LOCAL_SOURCE = 'true';
        delete process.env.MAX_UPLOAD_SIZE;
        delete process.env.LOCAL_SOURCE_ROOTS;

        sessionService = new SessionService({ emit: () => {} } as any);
        tusUploadService = {
            finalizeUpload: vi.fn().mockResolvedValue(undefined),
        };
        webhookService = { send: vi.fn().mockResolvedValue(undefined) };
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
        rmSync(mediaDir, { recursive: true, force: true });
        delete process.env.ALLOW_LOCAL_SOURCE;
        delete process.env.LOCAL_SOURCE_ROOTS;
        delete process.env.MAX_UPLOAD_SIZE;
    });

    describe('enablement', () => {
        it('is disabled unless ALLOW_LOCAL_SOURCE is exactly "true"', () => {
            delete process.env.ALLOW_LOCAL_SOURCE;
            expect(makeService().enabled).toBe(false);

            process.env.ALLOW_LOCAL_SOURCE = '1';
            expect(makeService().enabled).toBe(false);

            process.env.ALLOW_LOCAL_SOURCE = 'true';
            expect(makeService().enabled).toBe(true);
        });
    });

    describe('adopting a valid source', () => {
        it('hands the original path to finalizeUpload without copying it', async () => {
            const sessionId = makeSession();
            const source = writeMedia('holiday.mp4', 2048);

            await makeService().ingest(sessionId, source);

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                sessionId,
                source,
            );
            // Nothing was written into the work dir for this session.
            expect(existsSync(join(workDir, sessionId, 'holiday.mp4'))).toBe(
                false,
            );
            expect(existsSync(source)).toBe(true);
        });

        it('records the file size so clients can show total bytes', async () => {
            const sessionId = makeSession();
            const source = writeMedia('clip.mov', 4096);

            await makeService().ingest(sessionId, source);

            expect(sessionService.get(sessionId)?.ingestTotalBytes).toBe(4096);
        });

        it('reports "uploading" over the webhook when one is configured', async () => {
            const session = sessionService.create(makeConfig({ withWebhook: true }));
            const source = writeMedia('clip.mp4');

            await makeService().ingest(session.id, source);

            expect(webhookService.send).toHaveBeenCalledWith(
                'https://example.com/webhook',
                'tok',
                expect.objectContaining({ status: 'uploading' }),
            );
        });

        it('follows a symlink to the real file', async () => {
            const sessionId = makeSession();
            const real = writeMedia('real.mp4');
            const link = join(mediaDir, 'link.mp4');
            symlinkSync(real, link);

            await makeService().ingest(sessionId, link);

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                sessionId,
                real,
            );
        });
    });

    describe('the source file is never destroyed', () => {
        // This is the one behaviour that must not regress. UrlFetchService
        // unlinks its partial download on failure, which is right for a file it
        // created — copying that here would delete the user's own media.
        it('leaves the source in place when the post-ingest pipeline throws', async () => {
            const sessionId = makeSession();
            const source = writeMedia('precious.mp4');
            tusUploadService.finalizeUpload.mockRejectedValue(
                new Error('ffprobe exploded'),
            );

            await makeService().ingest(sessionId, source);

            expect(existsSync(source)).toBe(true);
            expect(sessionService.get(sessionId)?.status).toBe('failed');
            expect(sessionService.get(sessionId)?.error).toContain(
                'ffprobe exploded',
            );
        });

        it('leaves a rejected source untouched, and its whole directory intact', async () => {
            const sessionId = makeSession();
            writeMedia('keep-me.mp4');
            const rejected = writeMedia('notes.txt');

            await makeService().ingest(sessionId, rejected);

            expect(existsSync(rejected)).toBe(true);
            expect(readdirSync(mediaDir).sort()).toEqual([
                'keep-me.mp4',
                'notes.txt',
            ]);
        });
    });

    describe('rejected paths', () => {
        async function expectRejected(
            path: string,
            reason: RegExp,
        ): Promise<void> {
            const sessionId = makeSession();
            await makeService().ingest(sessionId, path);

            const session = sessionService.get(sessionId);
            expect(session?.status).toBe('failed');
            expect(session?.error).toMatch(reason);
            expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
        }

        it('rejects a relative path', async () => {
            await expectRejected('movies/clip.mp4', /must be absolute/i);
        });

        it('rejects a file that does not exist', async () => {
            await expectRejected(
                join(mediaDir, 'ghost.mp4'),
                /does not exist/i,
            );
        });

        it('rejects a directory', async () => {
            const dir = join(mediaDir, 'a-folder.mp4');
            mkdirSync(dir);
            await expectRejected(dir, /not a regular file/i);
        });

        it('rejects an unsupported extension', async () => {
            await expectRejected(writeMedia('notes.txt'), /unsupported file type/i);
        });

        it('rejects an empty file', async () => {
            await expectRejected(writeMedia('empty.mp4', 0), /empty/i);
        });

        it('rejects a file larger than MAX_UPLOAD_SIZE', async () => {
            process.env.MAX_UPLOAD_SIZE = '512';
            await expectRejected(writeMedia('big.mp4', 4096), /exceeds/i);
        });

        it('rejects a source inside the work directory', async () => {
            // It would sit in the tree the encoder creates, cleans and deletes
            // per session — including alongside its own output.
            const inside = join(workDir, 'sneaky.mp4');
            writeFileSync(inside, Buffer.alloc(16, 1));
            await expectRejected(inside, /outside the encoder work directory/i);
        });

        it('rejects a symlink whose target is inside the work directory', async () => {
            const target = join(workDir, 'target.mp4');
            writeFileSync(target, Buffer.alloc(16, 1));
            const link = join(mediaDir, 'innocent.mp4');
            symlinkSync(target, link);

            await expectRejected(link, /outside the encoder work directory/i);
        });
    });

    describe('LOCAL_SOURCE_ROOTS containment', () => {
        it('accepts a source under a permitted root', async () => {
            process.env.LOCAL_SOURCE_ROOTS = mediaDir;
            const sessionId = makeSession();
            const source = writeMedia('inside.mp4');

            await makeService().ingest(sessionId, source);

            expect(tusUploadService.finalizeUpload).toHaveBeenCalledWith(
                sessionId,
                source,
            );
        });

        it('rejects a source outside every permitted root', async () => {
            const otherDir = mkdtempSync(join(tmpdir(), 'local-source-other-'));
            try {
                process.env.LOCAL_SOURCE_ROOTS = otherDir;
                const sessionId = makeSession();
                const source = writeMedia('outside.mp4');

                await makeService().ingest(sessionId, source);

                expect(sessionService.get(sessionId)?.error).toMatch(
                    /outside the permitted directories/i,
                );
                expect(tusUploadService.finalizeUpload).not.toHaveBeenCalled();
                expect(existsSync(source)).toBe(true);
            } finally {
                rmSync(otherDir, { recursive: true, force: true });
            }
        });

        it('is unrestricted when LOCAL_SOURCE_ROOTS is unset', async () => {
            const sessionId = makeSession();
            const source = writeMedia('anywhere.mp4');

            await makeService().ingest(sessionId, source);

            expect(tusUploadService.finalizeUpload).toHaveBeenCalled();
        });
    });
});
