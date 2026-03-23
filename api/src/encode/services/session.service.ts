import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateSessionDto } from '../dto/create-session.dto.js';
import type { SessionStatus } from '../dto/webhook-payload.dto.js';
import type { ProbeResult } from './probe.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import type { SegmentFormat } from './ffmpeg.service.js';
import type { PipelineProgress } from './segment-pipeline.service.js';
import { SessionEventsService, type SessionEvent } from './session-events.service.js';

export interface AnglePlaylistInfo {
    name: string;
    key: string;
}

export interface Session {
    id: string;
    sessionToken: string;
    status: SessionStatus;
    progress: number;
    pipelineProgress?: PipelineProgress;
    config: CreateSessionDto;
    probeResult?: ProbeResult;
    encodeConfig?: EncodeConfigDto;
    filePath?: string;
    outputDir?: string;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: AnglePlaylistInfo[];
    thumbnailsVtt?: string;
    error?: string;
    segmentFormat?: SegmentFormat;
    createdAt: number;
}

@Injectable()
export class SessionService {
    private readonly logger = new Logger(SessionService.name);
    private readonly sessions = new Map<string, Session>();
    private readonly tokenIndex = new Map<string, string>();

    constructor(private readonly sessionEvents: SessionEventsService) {}

    private emitEvent(session: Session, extra?: Partial<SessionEvent>): void {
        this.sessionEvents.emit({
            sessionId: session.id,
            status: session.status,
            progress: session.progress || undefined,
            pipelineProgress: session.pipelineProgress,
            error: session.error,
            files: session.files,
            masterPlaylist: session.masterPlaylist,
            anglePlaylists: session.anglePlaylists,
            thumbnailsVtt: session.thumbnailsVtt,
            segmentFormat: session.segmentFormat,
            ...extra,
        });
    }

    create(config: CreateSessionDto): Session {
        const id = randomUUID();
        const sessionToken = `sess_${randomUUID().replace(/-/g, '')}`;

        const session: Session = {
            id,
            sessionToken,
            status: 'created',
            progress: 0,
            config,
            createdAt: Date.now(),
        };

        this.sessions.set(id, session);
        this.tokenIndex.set(sessionToken, id);
        this.logger.log(`Session created: ${id}`);

        return session;
    }

    get(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    getBySessionToken(token: string): Session | undefined {
        const id = this.tokenIndex.get(token);
        if (!id) return undefined;
        return this.sessions.get(id);
    }

    updateStatus(id: string, status: SessionStatus): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = status;
            this.emitEvent(session);
        }
    }

    updateProgress(id: string, progress: number): void {
        const session = this.sessions.get(id);
        if (session) {
            session.progress = progress;
            this.emitEvent(session);
        }
    }

    updatePipelineProgress(id: string, pipelineProgress: PipelineProgress): void {
        const session = this.sessions.get(id);
        if (session) {
            session.pipelineProgress = pipelineProgress;
            session.progress = pipelineProgress.encoding;
            this.emitEvent(session);
        }
    }

    setFilePath(id: string, filePath: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.filePath = filePath;
        }
    }

    setProbeResult(id: string, probeResult: ProbeResult): void {
        const session = this.sessions.get(id);
        if (session) {
            session.probeResult = probeResult;
            this.emitEvent(session, { probeResult });
        }
    }

    setEncodeConfig(id: string, encodeConfig: EncodeConfigDto): void {
        const session = this.sessions.get(id);
        if (session) {
            session.encodeConfig = encodeConfig;
        }
    }

    setOutputDir(id: string, outputDir: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.outputDir = outputDir;
        }
    }

    setCompleted(
        id: string,
        files: string[],
        masterPlaylist: string,
        anglePlaylists?: AnglePlaylistInfo[],
        thumbnailsVtt?: string,
        segmentFormat?: SegmentFormat,
    ): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = 'completed';
            session.progress = 100;
            session.files = files;
            session.masterPlaylist = masterPlaylist;
            session.anglePlaylists = anglePlaylists;
            session.thumbnailsVtt = thumbnailsVtt;
            session.segmentFormat = segmentFormat;
            this.emitEvent(session);
        }
    }

    setFailed(id: string, error: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = 'failed';
            session.error = error;
            this.emitEvent(session);
        }
    }

    remove(id: string): Session | undefined {
        const session = this.sessions.get(id);
        if (!session) return undefined;

        this.tokenIndex.delete(session.sessionToken);
        this.sessions.delete(id);
        this.logger.log(`Session removed: ${id}`);
        return session;
    }

    /**
     * Remove sessions older than the given max age (in ms).
     * Useful for periodic cleanup of completed/failed sessions.
     */
    cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
        const cutoff = Date.now() - maxAgeMs;
        let removed = 0;

        for (const [id, session] of this.sessions.entries()) {
            if (
                session.createdAt < cutoff &&
                (session.status === 'completed' || session.status === 'failed')
            ) {
                this.tokenIndex.delete(session.sessionToken);
                this.sessions.delete(id);
                removed++;
            }
        }

        if (removed > 0) {
            this.logger.log(`Cleaned up ${removed} expired session(s)`);
        }
        return removed;
    }
}
