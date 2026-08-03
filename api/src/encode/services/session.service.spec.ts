import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SessionService, type Session } from './session.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

const events = { emit: () => {} } as any;

function makeConfig(overrides: Partial<CreateSessionDto> = {}): CreateSessionDto {
    return {
        s3: {
            endPoint: 's3.example.com',
            bucket: 'test-bucket',
            accessKey: 'key',
            secretKey: 'secret',
        },
        webhook: {
            url: 'https://example.com/webhook',
            sessionToken: 'tok123',
        },
        ...overrides,
    };
}

describe('SessionService', () => {
    let service: SessionService;

    beforeEach(() => {
        service = new SessionService({ emit: () => {} } as any);
    });

    describe('create', () => {
        it('should create a session with a unique id and upload token', () => {
            const session = service.create(makeConfig());

            expect(session.id).toBeDefined();
            expect(session.sessionToken).toMatch(/^sess_/);
            expect(session.status).toBe('created');
            expect(session.progress).toBe(0);
            expect(session.config.s3.endPoint).toBe('s3.example.com');
            expect(session.createdAt).toBeLessThanOrEqual(Date.now());
        });

        it('should create sessions with unique ids', () => {
            const s1 = service.create(makeConfig());
            const s2 = service.create(makeConfig());

            expect(s1.id).not.toBe(s2.id);
            expect(s1.sessionToken).not.toBe(s2.sessionToken);
        });
    });

    describe('get', () => {
        it('should return a session by id', () => {
            const created = service.create(makeConfig());
            const found = service.get(created.id);

            expect(found).toBeDefined();
            expect(found!.id).toBe(created.id);
        });

        it('should return undefined for unknown id', () => {
            expect(service.get('nonexistent')).toBeUndefined();
        });
    });

    describe('getBySessionToken', () => {
        it('should return a session by upload token', () => {
            const created = service.create(makeConfig());
            const found = service.getBySessionToken(created.sessionToken);

            expect(found).toBeDefined();
            expect(found!.id).toBe(created.id);
        });

        it('should return undefined for unknown token', () => {
            expect(service.getBySessionToken('bad_token')).toBeUndefined();
        });
    });

    describe('updateStatus', () => {
        it('should update session status', () => {
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'encoding');

            expect(service.get(session.id)!.status).toBe('encoding');
        });

        it('should be a no-op for unknown id', () => {
            expect(() => service.updateStatus('nonexistent', 'encoding')).not.toThrow();
        });
    });

    describe('updateProgress', () => {
        it('should update session progress', () => {
            const session = service.create(makeConfig());
            service.updateProgress(session.id, 42.5);

            expect(service.get(session.id)!.progress).toBe(42.5);
        });
    });

    describe('updatePipelineProgress', () => {
        it('should set pipelineProgress and update progress from encoding field', () => {
            const emitSpy = vi.fn();
            const svc = new SessionService({ emit: emitSpy } as any);
            const session = svc.create(makeConfig());

            const pipelineProgress = { encoding: 55, encrypting: 30, uploading: 10 };
            svc.updatePipelineProgress(session.id, pipelineProgress);

            const updated = svc.get(session.id)!;
            expect(updated.pipelineProgress).toEqual(pipelineProgress);
            expect(updated.progress).toBe(55);
            expect(emitSpy).toHaveBeenCalled();
        });

        it('should be a no-op for unknown session id', () => {
            const emitSpy = vi.fn();
            const svc = new SessionService({ emit: emitSpy } as any);

            expect(() => svc.updatePipelineProgress('nonexistent', { encoding: 50 })).not.toThrow();
            // emit should not have been called (no session created)
            expect(emitSpy).not.toHaveBeenCalled();
        });
    });

    describe('setFilePath', () => {
        it('should set the file path on the session', () => {
            const session = service.create(makeConfig());
            service.setFilePath(session.id, '/tmp/test.mp4');

            expect(service.get(session.id)!.filePath).toBe('/tmp/test.mp4');
        });
    });

    describe('setOutputDir', () => {
        it('should set the output directory on the session', () => {
            const session = service.create(makeConfig());
            service.setOutputDir(session.id, '/tmp/output');

            expect(service.get(session.id)!.outputDir).toBe('/tmp/output');
        });
    });

    describe('setProbeResult', () => {
        it('should store probe result', () => {
            const session = service.create(makeConfig());
            const probeResult = {
                format: { duration: 60, bitrateKbps: 3000, formatName: 'mp4' },
                videoTracks: [],
                audioTracks: [],
            };
            service.setProbeResult(session.id, probeResult);

            const updated = service.get(session.id)!;
            expect(updated.probeResult).toEqual(probeResult);
        });
    });

    describe('setIngestTotal', () => {
        it('stores the total bytes and emits an event', () => {
            const emitSpy = vi.fn();
            const svc = new SessionService({ emit: emitSpy } as any);
            const session = svc.create(makeConfig());
            emitSpy.mockClear();

            svc.setIngestTotal(session.id, 524_288_000);

            expect(svc.get(session.id)!.ingestTotalBytes).toBe(524_288_000);
            expect(emitSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    sessionId: session.id,
                    ingestTotalBytes: 524_288_000,
                }),
            );
        });

        it('is a no-op for unknown session ids', () => {
            expect(() => service.setIngestTotal('does-not-exist', 100)).not.toThrow();
        });

        it('subsequent events include the total once set', () => {
            const emitSpy = vi.fn();
            const svc = new SessionService({ emit: emitSpy } as any);
            const session = svc.create(makeConfig());
            svc.setIngestTotal(session.id, 1000);
            emitSpy.mockClear();

            svc.updateProgress(session.id, 50);

            expect(emitSpy).toHaveBeenCalledWith(
                expect.objectContaining({ ingestTotalBytes: 1000, progress: 50 }),
            );
        });
    });

    describe('setEncodeConfig', () => {
        it('should store encode config', () => {
            const session = service.create(makeConfig());
            const encodeConfig = {
                type: 'video' as const,
                videoRenditions: [{ width: 1280, height: 720, videoBitrateKbps: 2500, copyStream: false, audioGroupId: 'hd' }],
                audioGroups: [{ id: 'hd', audioBitrateKbps: 128, channels: 2, audioCodec: 'aac' as const, sourceTrackIndex: 0 }],
            };
            service.setEncodeConfig(session.id, encodeConfig);

            expect(service.get(session.id)!.encodeConfig).toEqual(encodeConfig);
        });
    });

    describe('setCompleted', () => {
        it('should mark session as completed with files and playlist', () => {
            const session = service.create(makeConfig());
            const files = ['master.m3u8', 'v0/playlist.m3u8'];
            service.setCompleted(session.id, files, 'master.m3u8');

            const updated = service.get(session.id)!;
            expect(updated.status).toBe('completed');
            expect(updated.progress).toBe(100);
            expect(updated.files).toEqual(files);
            expect(updated.masterPlaylist).toBe('master.m3u8');
        });
    });

    describe('setFailed', () => {
        it('should mark session as failed with an error message', () => {
            const session = service.create(makeConfig());
            service.setFailed(session.id, 'FFmpeg crashed');

            const updated = service.get(session.id)!;
            expect(updated.status).toBe('failed');
            expect(updated.error).toBe('FFmpeg crashed');
        });
    });

    describe('cleanupAbandoned', () => {
        const idle = (id: string, hours: number) => {
            (service.get(id) as any).lastActivityAt =
                Date.now() - hours * 3_600_000;
        };

        it('removes an upload that was never encoded', () => {
            // The 7 GB-and-a-closed-tab case: nothing else has ever bounded
            // these, not size and not age.
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'uploaded');
            idle(session.id, 8);

            expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(1);
            expect(service.get(session.id)).toBeUndefined();
        });

        it('leaves a session that is still doing something', () => {
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'uploaded');
            idle(session.id, 1);

            expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(0);
            expect(service.get(session.id)).toBeDefined();
        });

        it('spares a slow upload that is still delivering bytes', () => {
            // A tus upload reports progress to tusd, not to us, so nothing here
            // moves while gigabytes arrive — `touch` is the only sign of life a
            // long transfer gives. Without it this session is swept mid-upload.
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'uploading');
            idle(session.id, 20);

            service.touch(session.id);

            expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(0);
            expect(service.get(session.id)).toBeDefined();
        });

        it('sweeps an upload that stopped delivering', () => {
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'uploading');
            idle(session.id, 20);

            expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(1);
        });

        it('never touches a session mid-encode', () => {
            // Deleting the source out from under a running encode would be far
            // worse than the disk it reclaims.
            for (const status of ['encoding', 'encrypting', 'uploading_to_s3'] as const) {
                const session = service.create(makeConfig());
                service.updateStatus(session.id, status);
                idle(session.id, 100);

                expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(0);
                expect(service.get(session.id)).toBeDefined();
            }
        });

        it('leaves queued sessions alone', () => {
            // The source is needed, and a long backlog is a legitimate reason
            // for a session to sit still.
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'queued');
            idle(session.id, 100);

            expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(0);
            expect(service.get(session.id)).toBeDefined();
        });

        it('leaves finished sessions to the other sweep', () => {
            const done = service.create(makeConfig());
            service.setCompleted(done.id, [], '');
            idle(done.id, 100);
            const failed = service.create(makeConfig());
            service.setFailed(failed.id, 'err');
            idle(failed.id, 100);

            expect(service.cleanupAbandoned(6 * 3_600_000)).toBe(0);
            expect(service.get(done.id)).toBeDefined();
            expect(service.get(failed.id)).toBeDefined();
        });

        it('releases the session token too', () => {
            const session = service.create(makeConfig());
            service.updateStatus(session.id, 'uploaded');
            idle(session.id, 8);

            service.cleanupAbandoned(6 * 3_600_000);
            expect(
                service.getBySessionToken(session.sessionToken),
            ).toBeUndefined();
        });
    });

    describe('cleanup', () => {
        it('should remove old completed/failed sessions', () => {
            const s1 = service.create(makeConfig());
            const s2 = service.create(makeConfig());
            const s3 = service.create(makeConfig());

            service.setCompleted(s1.id, [], '');
            (service.get(s1.id) as any).createdAt = Date.now() - 2 * 86400000;

            service.setFailed(s2.id, 'err');
            (service.get(s2.id) as any).createdAt = Date.now() - 2 * 86400000;

            (service.get(s3.id) as any).createdAt = Date.now() - 2 * 86400000;

            const removed = service.cleanup(86400000);
            expect(removed).toBe(2);
            expect(service.get(s1.id)).toBeUndefined();
            expect(service.get(s2.id)).toBeUndefined();
            expect(service.get(s3.id)).toBeDefined();
        });

        it('should not remove recent sessions', () => {
            const session = service.create(makeConfig());
            service.setCompleted(session.id, [], '');

            const removed = service.cleanup(86400000);
            expect(removed).toBe(0);
            expect(service.get(session.id)).toBeDefined();
        });

        it('should remove token index entries for cleaned sessions', () => {
            const session = service.create(makeConfig());
            service.setCompleted(session.id, [], '');
            (service.get(session.id) as any).createdAt = 0;

            service.cleanup(1000);
            expect(service.getBySessionToken(session.sessionToken)).toBeUndefined();
        });
    });
});
describe('SessionService — surviving a restart', () => {
    let workDir: string;

    beforeEach(() => {
        workDir = mkdtempSync(join(tmpdir(), 'luminary-sessions-'));
        process.env.WORK_DIR = workDir;
    });

    afterEach(() => {
        rmSync(workDir, { recursive: true, force: true });
        delete process.env.WORK_DIR;
    });

    /** A second service over the same work dir stands in for a restarted process. */
    function restart(): SessionService {
        const next = new SessionService(events);
        next.onModuleInit();
        return next;
    }

    it('writes a session to disk when it is created', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        const path = join(workDir, session.id, 'session.json');
        expect(existsSync(path)).toBe(true);
        expect(JSON.parse(readFileSync(path, 'utf-8')).id).toBe(session.id);
    });

    it('finds the session again after a restart, token and all', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.updateStatus(session.id, 'uploaded');
        service.setFilePath(session.id, '/tmp/source.mp4');

        const after = restart();
        expect(after.get(session.id)?.filePath).toBe('/tmp/source.mp4');
        expect(after.getBySessionToken(session.sessionToken)?.id).toBe(session.id);
    });

    it('keeps the encode config, so a trimmed session still knows its ranges', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.setEncodeConfig(session.id, {
            type: 'video',
            trimSegments: [{ inSec: 10, outSec: 20 }],
        } as any);

        expect(restart().get(session.id)?.encodeConfig?.trimSegments).toEqual([
            { inSec: 10, outSec: 20 },
        ]);
    });

    it('marks a session that was mid-encode as failed rather than still running', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.updateStatus(session.id, 'encoding');

        const restored = restart().get(session.id);
        // The FFmpeg process died with the old process; claiming otherwise would
        // leave the client waiting forever.
        expect(restored?.status).toBe('failed');
        expect(restored?.error).toMatch(/restarted/i);
    });

    it('offers up the sessions the restart killed, so they can be reported', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.updateStatus(session.id, 'encoding');

        // Nothing else tells the holder of the other half of this session that it
        // stopped, and the record would otherwise read `encoding` forever.
        expect(restart().takeRestartFailures().map((s) => s.id)).toEqual([
            session.id,
        ]);
    });

    it('offers each killed session only once', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.updateStatus(session.id, 'encoding');

        const after = restart();
        after.takeRestartFailures();
        expect(after.takeRestartFailures()).toEqual([]);
    });

    it('has nothing to report when every session was already finished', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.setCompleted(session.id, ['master.m3u8'], 'master.m3u8');

        expect(restart().takeRestartFailures()).toEqual([]);
    });

    it.each(['uploading', 'queued', 'encrypting', 'uploading_to_s3'] as const)(
        'does the same for a session left in %s',
        (status) => {
            const service = new SessionService(events);
            const session = service.create(makeConfig());
            service.updateStatus(session.id, status);
            expect(restart().get(session.id)?.status).toBe('failed');
        },
    );

    it('leaves a completed session completed', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.setCompleted(session.id, ['master.m3u8'], 'master.m3u8');

        const restored = restart().get(session.id);
        expect(restored?.status).toBe('completed');
        expect(restored?.files).toEqual(['master.m3u8']);
    });

    it('does not bring back a session that was deleted', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.remove(session.id);

        expect(existsSync(join(workDir, session.id, 'session.json'))).toBe(false);
        expect(restart().get(session.id)).toBeUndefined();
    });

    it('does not bring back a session that was cleaned up', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.setCompleted(session.id, [], '');
        (service.get(session.id) as Session).createdAt = Date.now() - 48 * 60 * 60 * 1000;
        service.cleanup();

        expect(restart().get(session.id)).toBeUndefined();
    });

    it('reclaims the working directory when a session ages out', () => {
        // The record alone is not the point: the source upload lives here, and
        // nothing else ever prunes it.
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.setCompleted(session.id, [], '');
        writeFileSync(join(workDir, session.id, 'source.mp4'), 'pretend media');
        (service.get(session.id) as Session).createdAt = Date.now() - 48 * 60 * 60 * 1000;

        service.cleanup();

        expect(existsSync(join(workDir, session.id))).toBe(false);
    });

    it('reclaims the working directory when a session is deleted', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        writeFileSync(join(workDir, session.id, 'source.mp4'), 'pretend media');

        service.remove(session.id);

        expect(existsSync(join(workDir, session.id))).toBe(false);
    });

    it('leaves a session that is still young alone', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.setCompleted(session.id, [], '');

        service.cleanup();

        expect(service.get(session.id)).toBeDefined();
        expect(existsSync(join(workDir, session.id))).toBe(true);
    });

    it('leaves an unfinished session alone however old it is', () => {
        // Sweeping something mid-encode would delete the input from under FFmpeg.
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        service.updateStatus(session.id, 'encoding');
        (service.get(session.id) as Session).createdAt = Date.now() - 48 * 60 * 60 * 1000;

        service.cleanup();

        expect(service.get(session.id)).toBeDefined();
        expect(existsSync(join(workDir, session.id))).toBe(true);
    });

    it('ignores unreadable records instead of failing to start', () => {
        mkdirSync(join(workDir, 'broken'), { recursive: true });
        writeFileSync(join(workDir, 'broken', 'session.json'), '{ not json');
        const service = new SessionService(events);
        expect(() => service.onModuleInit()).not.toThrow();
    });

    it('ignores directories that hold no session record', () => {
        mkdirSync(join(workDir, 'stray-output'), { recursive: true });
        const service = new SessionService(events);
        expect(() => service.onModuleInit()).not.toThrow();
    });

    it('keeps the record readable only by the owner — it carries S3 credentials', () => {
        const service = new SessionService(events);
        const session = service.create(makeConfig());
        const mode = statSync(join(workDir, session.id, 'session.json')).mode & 0o777;
        expect(mode).toBe(0o600);
    });
});
