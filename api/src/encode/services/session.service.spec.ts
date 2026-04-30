import { SessionService } from './session.service.js';
import type { CreateSessionDto } from '../dto/create-session.dto.js';

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
