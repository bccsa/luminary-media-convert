import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CreateSessionDto } from '../dto/create-session.dto.js';
import type { SessionStatus } from '../dto/webhook-payload.dto.js';
import type { ProbeResult } from './probe.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import type { SegmentFormat } from './ffmpeg.service.js';
import type { PipelineProgress } from './segment-pipeline.service.js';
import { SessionEventsService, type SessionEvent } from './session-events.service.js';

/**
 * The persisted session record, inside the session's own work directory. Anything
 * clearing that directory has to spare this file or the session stops existing.
 */
export const SESSION_STATE_FILENAME = 'session.json';

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
    encryptionKeyHex?: string;
    error?: string;
    segmentFormat?: SegmentFormat;
    ingestTotalBytes?: number;
    createdAt: number;
    /**
     * When this session last did anything.
     *
     * Abandonment cannot be judged on `createdAt`: a 10 GB upload over a poor
     * link is hours old and perfectly alive, while a tab closed on the config
     * screen is hours old and never coming back. Only the gap since the last
     * sign of life tells those apart.
     */
    lastActivityAt: number;
}

/** Statuses that cannot survive the process that was driving them. */
const IN_FLIGHT: SessionStatus[] = [
    'uploading',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
];

@Injectable()
export class SessionService implements OnModuleInit {
    private readonly logger = new Logger(SessionService.name);
    private readonly sessions = new Map<string, Session>();
    private readonly tokenIndex = new Map<string, string>();
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');

    /**
     * Sessions that `restore()` found mid-encode and marked failed, waiting to be
     * reported outward. Kept here rather than sent from here: this service owns
     * session state and has no business making outbound HTTP calls, and it is
     * constructed directly in a great many tests that should not need a webhook
     * client to exist.
     */
    private restartFailures: Session[] = [];

    constructor(private readonly sessionEvents: SessionEventsService) {}

    /**
     * Hands over the sessions abandoned by a restart, clearing them so they are
     * reported once. Empty on every call but the first after startup.
     */
    takeRestartFailures(): Session[] {
        const failures = this.restartFailures;
        this.restartFailures = [];
        return failures;
    }

    /**
     * Sessions outlive the process. Without this, restarting the API — which every
     * deploy does — orphans every session: the SaaS still has its record, the API
     * has never heard of it, and the client is met with 401 on every route.
     */
    onModuleInit(): void {
        this.restore();
    }

    private sessionFile(id: string): string {
        return join(this.workDir, id, SESSION_STATE_FILENAME);
    }

    /**
     * Written after anything worth keeping changes. Progress is deliberately not
     * one of those things: it ticks several times a second and is worthless after
     * a restart, since whatever was producing it is gone.
     */
    private persist(session: Session): void {
        const path = this.sessionFile(session.id);
        try {
            mkdirSync(join(this.workDir, session.id), { recursive: true });
            const tmp = `${path}.tmp`;
            // Session config carries S3 credentials, so keep it to the owner and
            // swap it into place rather than leaving a half-written file.
            writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
            renameSync(tmp, path);
        } catch (err) {
            this.logger.warn(
                `Could not persist session ${session.id}: ${(err as Error).message}`,
            );
        }
    }

    /**
     * Drop everything the session left on disk: the record, so it cannot come back
     * on the next restart, and the working directory holding its source upload,
     * preview cache and sidecars. Nothing else prunes these.
     */
    private purge(id: string): void {
        try {
            rmSync(join(this.workDir, id), { recursive: true, force: true });
        } catch (err) {
            this.logger.warn(
                `Could not remove working directory for session ${id}: ${(err as Error).message}`,
            );
        }
    }

    private restore(): void {
        if (!existsSync(this.workDir)) return;

        let restored = 0;
        let abandoned = 0;
        for (const entry of readdirSync(this.workDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const path = join(this.workDir, entry.name, 'session.json');
            if (!existsSync(path)) continue;

            try {
                const session = JSON.parse(readFileSync(path, 'utf-8')) as Session;
                if (!session?.id || !session?.sessionToken) continue;

                // Written before sessions carried an activity stamp. Falling
                // back to createdAt keeps the sweep from treating every
                // pre-existing session as freshly active.
                session.lastActivityAt ??= session.createdAt;

                if (IN_FLIGHT.includes(session.status)) {
                    // The queue and the FFmpeg process died with the old process;
                    // reporting these as still running would be a lie the client
                    // would wait on forever.
                    session.status = 'failed';
                    session.error =
                        'The encoder restarted while this session was in progress.';
                    // Whoever holds the other half of this session still believes
                    // it is running, and nothing else will ever tell them
                    // otherwise. Handed to the notifier once the app is up.
                    this.restartFailures.push(session);
                    abandoned++;
                }

                this.sessions.set(session.id, session);
                this.tokenIndex.set(session.sessionToken, session.id);
                this.persist(session);
                restored++;
            } catch (err) {
                this.logger.warn(
                    `Could not restore session from ${path}: ${(err as Error).message}`,
                );
            }
        }

        if (restored > 0) {
            this.logger.log(
                `Restored ${restored} session(s) from disk` +
                    (abandoned > 0 ? `, ${abandoned} marked failed after restart` : ''),
            );
        }
    }

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
            encryptionKeyHex: session.encryptionKeyHex,
            segmentFormat: session.segmentFormat,
            ingestTotalBytes: session.ingestTotalBytes,
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
            lastActivityAt: Date.now(),
        };

        this.sessions.set(id, session);
        this.tokenIndex.set(sessionToken, id);
        this.persist(session);
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
            session.lastActivityAt = Date.now();
            this.persist(session);
            this.emitEvent(session);
        }
    }

    updateProgress(id: string, progress: number): void {
        const session = this.sessions.get(id);
        if (session) {
            session.progress = progress;
            session.lastActivityAt = Date.now();
            this.emitEvent(session);
        }
    }

    /**
     * Record a sign of life without changing anything else.
     *
     * A tus upload reports its progress to tusd, not to us, so nothing here
     * moves while gigabytes are arriving. Without this a slow upload looks
     * identical to an abandoned one and `cleanupAbandoned` would delete it
     * mid-transfer.
     */
    touch(id: string): void {
        const session = this.sessions.get(id);
        if (session) session.lastActivityAt = Date.now();
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
            this.persist(session);
        }
    }

    setIngestTotal(id: string, bytes: number): void {
        const session = this.sessions.get(id);
        if (session) {
            session.ingestTotalBytes = bytes;
            this.persist(session);
            this.emitEvent(session);
        }
    }

    setProbeResult(id: string, probeResult: ProbeResult): void {
        const session = this.sessions.get(id);
        if (session) {
            session.probeResult = probeResult;
            this.persist(session);
            this.emitEvent(session, { probeResult });
        }
    }

    setEncodeConfig(id: string, encodeConfig: EncodeConfigDto): void {
        const session = this.sessions.get(id);
        if (session) {
            session.encodeConfig = encodeConfig;
            this.persist(session);
        }
    }

    setOutputDir(id: string, outputDir: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.outputDir = outputDir;
            this.persist(session);
        }
    }

    setCompleted(
        id: string,
        files: string[],
        masterPlaylist: string,
        anglePlaylists?: AnglePlaylistInfo[],
        thumbnailsVtt?: string,
        segmentFormat?: SegmentFormat,
        encryptionKeyHex?: string,
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
            session.encryptionKeyHex = encryptionKeyHex;
            this.persist(session);
            this.emitEvent(session);
        }
    }

    setFailed(id: string, error: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = 'failed';
            session.error = error;
            this.persist(session);
            this.emitEvent(session);
        }
    }

    remove(id: string): Session | undefined {
        const session = this.sessions.get(id);
        if (!session) return undefined;

        this.tokenIndex.delete(session.sessionToken);
        this.sessions.delete(id);
        this.purge(id);
        this.logger.log(`Session removed: ${id}`);
        return session;
    }

    /**
     * Remove sessions older than the given max age (in ms).
     * Useful for periodic cleanup of completed/failed sessions.
     */
    /**
     * Remove sessions that were started and then walked away from.
     *
     * `cleanup` only ever considered `completed` and `failed`, so a session that
     * uploaded and was never encoded was bounded by nothing at all — not by size
     * and not by age. Someone who uploads 7 GB, looks at the config form and
     * closes the tab leaves that 7 GB on the volume permanently; the disk
     * exhaustion in #130 found 6.9 GB of `/work` being exactly that.
     *
     * Only genuinely idle states are swept. Anything mid-encode is left alone —
     * it is doing work someone is waiting on — and so is `queued`, where the
     * source is needed and a long backlog is a legitimate reason to sit still.
     */
    cleanupAbandoned(maxAgeMs: number): number {
        const cutoff = Date.now() - maxAgeMs;
        const idle: SessionStatus[] = ['created', 'uploading', 'uploaded'];
        let removed = 0;

        for (const [id, session] of this.sessions.entries()) {
            if (!idle.includes(session.status)) continue;
            if (session.lastActivityAt >= cutoff) continue;

            this.tokenIndex.delete(session.sessionToken);
            this.sessions.delete(id);
            this.purge(id);
            // Named individually: this deletes a customer's uploaded media,
            // which should never be something you discover by its absence.
            this.logger.log(
                `Removed abandoned session ${id} (${session.status}, ` +
                    `idle ${Math.round((Date.now() - session.lastActivityAt) / 3_600_000)}h)`,
            );
            removed++;
        }

        return removed;
    }

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
                this.purge(id);
                // Named individually: this deletes a customer's uploaded media,
                // which should never be something you discover by its absence.
                this.logger.log(
                    `Cleaned up session ${id} (${session.status}, ` +
                        `${Math.round((Date.now() - session.createdAt) / 3_600_000)}h old)`,
                );
                removed++;
            }
        }

        if (removed > 0) {
            this.logger.log(`Cleaned up ${removed} expired session(s)`);
        }
        return removed;
    }
}
