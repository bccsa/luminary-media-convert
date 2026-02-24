import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { CreateSessionDto } from '../dto/create-session.dto.js';
import type { SessionStatus } from '../dto/webhook-payload.dto.js';
import type { ProbeResult, SuggestedConfig } from './probe.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';

export interface AnglePlaylistInfo {
    name: string;
    key: string;
}

export interface Session {
    id: string;
    uploadToken: string;
    status: SessionStatus;
    progress: number;
    config: CreateSessionDto;
    probeResult?: ProbeResult;
    suggestedConfig?: SuggestedConfig;
    encodeConfig?: EncodeConfigDto;
    filePath?: string;
    outputDir?: string;
    files?: string[];
    masterPlaylist?: string;
    anglePlaylists?: AnglePlaylistInfo[];
    error?: string;
    createdAt: number;
}

@Injectable()
export class SessionService {
    private readonly logger = new Logger(SessionService.name);
    private readonly sessions = new Map<string, Session>();
    private readonly tokenIndex = new Map<string, string>();

    create(config: CreateSessionDto): Session {
        const id = randomUUID();
        const uploadToken = `tok_${randomUUID().replace(/-/g, '')}`;

        const session: Session = {
            id,
            uploadToken,
            status: 'created',
            progress: 0,
            config,
            createdAt: Date.now(),
        };

        this.sessions.set(id, session);
        this.tokenIndex.set(uploadToken, id);
        this.logger.log(`Session created: ${id}`);

        return session;
    }

    get(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    getByUploadToken(token: string): Session | undefined {
        const id = this.tokenIndex.get(token);
        if (!id) return undefined;
        return this.sessions.get(id);
    }

    updateStatus(id: string, status: SessionStatus): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = status;
        }
    }

    updateProgress(id: string, progress: number): void {
        const session = this.sessions.get(id);
        if (session) {
            session.progress = progress;
        }
    }

    setFilePath(id: string, filePath: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.filePath = filePath;
        }
    }

    setProbeResult(id: string, probeResult: ProbeResult, suggestedConfig: SuggestedConfig): void {
        const session = this.sessions.get(id);
        if (session) {
            session.probeResult = probeResult;
            session.suggestedConfig = suggestedConfig;
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
    ): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = 'completed';
            session.progress = 100;
            session.files = files;
            session.masterPlaylist = masterPlaylist;
            session.anglePlaylists = anglePlaylists;
        }
    }

    setFailed(id: string, error: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = 'failed';
            session.error = error;
        }
    }

    remove(id: string): Session | undefined {
        const session = this.sessions.get(id);
        if (!session) return undefined;

        this.tokenIndex.delete(session.uploadToken);
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
                this.tokenIndex.delete(session.uploadToken);
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
