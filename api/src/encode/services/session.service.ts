import {
    Inject,
    Injectable,
    Logger,
    Optional,
    type OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { CreateSessionDto } from '../dto/create-session.dto.js';
import type { SessionStatus } from '../session-status.js';
import type { ProbeResult } from './probe.service.js';
import type { EncodeConfigDto } from '../dto/encode-config.dto.js';
import type { SegmentFormat } from './ffmpeg.service.js';
import type { PipelineProgress } from './segment-pipeline.service.js';
import {
    SessionEventsService,
    type SessionEvent,
} from './session-events.service.js';
import {
    CREDENTIAL_CIPHER,
    type CredentialCipher,
} from './credential-cipher.js';

/**
 * The persisted session record, inside the session's own work directory. Anything
 * clearing that directory has to spare this file or the session stops existing.
 */
export const SESSION_STATE_FILENAME = 'session.json';

/**
 * The encrypted S3 credentials belonging to the session record beside it.
 * Written only when a host cipher exists; readable only by the same host.
 */
export const CREDENTIALS_FILENAME = 'credentials.enc';

/**
 * What stands in for an S3 key in `session.json`.
 *
 * Deliberately a value that cannot be mistaken for a credential: anything
 * finding this in a config is looking at a record that came back from disk
 * without its secrets, and must refuse to use it rather than send it to S3.
 */
export const REDACTED_CREDENTIAL = '<redacted>';

/** What a session is told when its credentials did not survive the restart. */
const CREDENTIALS_LOST =
    'Credentials unavailable after restart — create the session again from the CMS';

export interface Session {
    id: string;
    sessionToken: string;
    /**
     * Read-only credential handed to whoever asked for the session but does not
     * drive it — today, the CMS that opened it. Watches the event stream and
     * polls status; cannot encode, cancel, or reach the source file.
     *
     * It has no expiry, and that is deliberate rather than overlooked. Its
     * lifetime is the session's: it is minted with the session and stops
     * resolving the moment the session is removed, which is a bound the session
     * already has — sessions are purged at boot and swept when abandoned. An
     * expiry shorter than that would break the case the token exists for, a CMS
     * watching an encode that can legitimately run for hours; one longer than
     * that would never be reached.
     *
     * What makes that acceptable is how little it can do and how far it can
     * travel: read-only, scoped to one session, over a loopback interface, to a
     * caller whose origin was approved by the user. Widen any of those — a
     * network-reachable deployment, or a token that could start work — and this
     * should be revisited.
     */
    readToken?: string;
    /** Post title from the CMS, so the local UI can name the session. */
    title?: string;
    /** The CMS document this session's output belongs to. */
    documentId?: string;
    /** Public base URL the destination bucket is served from. */
    publicBaseUrl?: string;
    /** Final playback URL, known once encoding starts and the key prefix is fixed. */
    hlsUrl?: string;
    /** Who opened the session: a CMS over the network, or the local UI. */
    origin?: 'cms' | 'local';
    /** The normalised browser origin that opened it, for a CMS session. */
    createdByOrigin?: string;
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
    thumbnailsVtt?: string;
    encryptionKeyHex?: string;
    error?: string;
    /**
     * Something the encode had to do differently from what was asked, on a
     * session that otherwise succeeded.
     *
     * Today that is only the quick-cut fallback: a source whose keyframe
     * geometry turns out at encode time not to support a smart cut is
     * re-encoded instead of failed, and this is how the user finds out why the
     * fast path they picked took as long as a full encode. Distinct from
     * `error`, which says the session produced nothing.
     */
    fallbackNote?: string;
    segmentFormat?: SegmentFormat;
    ingestTotalBytes?: number;
    /**
     * Thumbnails sampled so far for the source storyboard. Transient, like
     * `progress`: it ticks throughout the ingest pass and describes work that
     * has to start over after a restart anyway, so it is never persisted.
     */
    storyboardThumbCount?: number;
    /** True once the storyboard's final VTT is on disk. Transient, as above. */
    storyboardComplete?: boolean;
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

/** Statuses nothing will move again. */
const TERMINAL: SessionStatus[] = ['completed', 'failed'];

/** Statuses a session can still be worked on from. */
const ACTIVE: SessionStatus[] = [
    'created',
    'uploading',
    'uploaded',
    'queued',
    'encoding',
    'encrypting',
    'uploading_to_s3',
];

/** What the caller knows about a session that the encoder itself cannot infer. */
export interface SessionInit {
    title?: string;
    documentId?: string;
    publicBaseUrl?: string;
    origin?: 'cms' | 'local';
    /**
     * The normalised browser origin that opened this session, when one did.
     *
     * `origin` above says which tier opened it; this says *who*. Idempotency is
     * a per-origin property: without an identity to compare, a repeat click was
     * recognised by `documentId` alone, so one approved site naming another's
     * document was handed that session's read token — the one thing approving a
     * site is not supposed to grant.
     */
    createdByOrigin?: string;
}

@Injectable()
export class SessionService implements OnModuleInit {
    private readonly logger = new Logger(SessionService.name);
    private readonly sessions = new Map<string, Session>();
    private readonly tokenIndex = new Map<string, string>();
    private readonly readTokenIndex = new Map<string, string>();
    private readonly workDir =
        process.env.WORK_DIR || join(process.cwd(), 'work');

    /** So the "credentials are memory-only" warning is said once, not per session. */
    private warnedMemoryOnly = false;

    constructor(
        private readonly sessionEvents: SessionEventsService,
        @Optional()
        @Inject(CREDENTIAL_CIPHER)
        private readonly cipher?: CredentialCipher
    ) {}

    /**
     * Sessions outlive the process. Without this, restarting the API — which every
     * deploy does — orphans every session: the SaaS still has its record, the API
     * has never heard of it, and the client is met with 401 on every route.
     */
    onModuleInit(): void {
        if (!this.cipher) this.warnMemoryOnly();
        this.restore();
    }

    private sessionFile(id: string): string {
        return join(this.workDir, id, SESSION_STATE_FILENAME);
    }

    private credentialsFile(id: string): string {
        return join(this.workDir, id, CREDENTIALS_FILENAME);
    }

    private warnMemoryOnly(): void {
        if (this.warnedMemoryOnly) return;
        this.warnedMemoryOnly = true;
        this.logger.warn(
            'No credential cipher available — S3 credentials are held in memory ' +
                'only and sessions will not survive a restart'
        );
    }

    /**
     * Written after anything worth keeping changes. Progress is deliberately not
     * one of those things: it ticks several times a second and is worthless after
     * a restart, since whatever was producing it is gone.
     */
    private persist(session: Session): void {
        try {
            mkdirSync(join(this.workDir, session.id), { recursive: true });
            // The record itself never carries S3 keys, cipher or no cipher: a
            // file on the user's disk is exactly the place a stolen credential
            // is found, and nothing reading `session.json` needs them.
            this.writeAtomic(
                this.sessionFile(session.id),
                JSON.stringify(this.withoutCredentials(session))
            );
            this.persistCredentials(session);
        } catch (err) {
            this.logger.warn(
                `Could not persist session ${session.id}: ${(err as Error).message}`
            );
        }
    }

    /** Owner-only, and swapped into place rather than left half-written. */
    private writeAtomic(path: string, body: string): void {
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, body, { mode: 0o600 });
        renameSync(tmp, path);
    }

    /** A copy of the session whose S3 keys have been replaced by a placeholder. */
    private withoutCredentials(session: Session): Session {
        if (!session.config?.s3) return session;
        return {
            ...session,
            config: {
                ...session.config,
                s3: {
                    ...session.config.s3,
                    accessKey: REDACTED_CREDENTIAL,
                    secretKey: REDACTED_CREDENTIAL,
                },
            },
        };
    }

    /**
     * Keep the session's S3 keys where only this host can read them again.
     *
     * With a cipher, they go in a sidecar the OS keychain holds the key to.
     * Without one there is nowhere safe to put them, so nothing is written and
     * the session simply cannot outlive the process — a stranded session is a
     * far smaller problem than a plaintext key sitting in the work directory.
     */
    private persistCredentials(session: Session): void {
        const path = this.credentialsFile(session.id);
        const s3 = session.config?.s3;

        // Nothing worth keeping: either no cipher, or a session restored without
        // its credentials, whose config now holds placeholders. Writing those
        // back would only make a useless sidecar look like a usable one.
        if (
            !this.cipher ||
            !s3?.accessKey ||
            !s3?.secretKey ||
            s3.accessKey === REDACTED_CREDENTIAL ||
            s3.secretKey === REDACTED_CREDENTIAL
        ) {
            if (!this.cipher) this.warnMemoryOnly();
            rmSync(path, { force: true });
            return;
        }

        this.writeAtomic(
            path,
            this.cipher.encrypt(
                JSON.stringify({
                    accessKey: s3.accessKey,
                    secretKey: s3.secretKey,
                })
            )
        );
    }

    /**
     * Put the S3 keys back on a session that has just come off disk.
     *
     * Returns false when they are gone for good — no cipher, no sidecar, or a
     * sidecar this host can no longer decrypt (a different machine, a reset
     * keychain). The caller has to treat that session as unusable.
     */
    private recoverCredentials(session: Session): boolean {
        const s3 = session.config?.s3;
        if (!this.cipher || !s3) return false;

        const path = this.credentialsFile(session.id);
        if (!existsSync(path)) return false;

        try {
            const { accessKey, secretKey } = JSON.parse(
                this.cipher.decrypt(readFileSync(path, 'utf-8'))
            ) as { accessKey?: string; secretKey?: string };
            if (!accessKey || !secretKey) return false;

            s3.accessKey = accessKey;
            s3.secretKey = secretKey;
            return true;
        } catch (err) {
            this.logger.warn(
                `Could not recover credentials for session ${session.id}: ${(err as Error).message}`
            );
            return false;
        }
    }

    /**
     * Whether this session's stored credentials are real ones.
     *
     * False only for a session restored without its sidecar: its config still
     * has the placeholders written to `session.json`, and anything reaching S3
     * with those would fail at the far end with an authentication error nobody
     * could trace back to a restart.
     */
    hasUsableCredentials(session: Session): boolean {
        const s3 = session.config?.s3;
        return (
            !!s3 &&
            !!s3.accessKey &&
            !!s3.secretKey &&
            s3.accessKey !== REDACTED_CREDENTIAL &&
            s3.secretKey !== REDACTED_CREDENTIAL
        );
    }

    /**
     * Drop everything the session left on disk: the record, so it cannot come back
     * on the next restart, the encrypted credential sidecar beside it, and the
     * working directory holding its source upload, preview cache and other
     * sidecars. Removing the directory whole is what covers all of them; nothing
     * else prunes these.
     */
    private purge(id: string): void {
        try {
            rmSync(join(this.workDir, id), { recursive: true, force: true });
        } catch (err) {
            this.logger.warn(
                `Could not remove working directory for session ${id}: ${(err as Error).message}`
            );
        }
    }

    /**
     * Drop a session's encoded output but keep its source upload.
     *
     * The same bargain `cleanupSessionFiles` strikes for an encode that fails
     * while the app is running: the output is regenerable, the source is
     * gigabytes the user would otherwise have to send again, so a retry stays
     * cheap. A crash gets the same treatment — before this, its output sat
     * untouched through the whole next session and was only reclaimed by the
     * boot after that, since a `failed` session is not swept on a clock.
     */
    private purgeOutput(id: string): void {
        try {
            rmSync(join(this.workDir, id, 'output'), {
                recursive: true,
                force: true,
            });
        } catch (err) {
            this.logger.warn(
                `Could not remove output for session ${id}: ${(err as Error).message}`
            );
        }
    }

    /**
     * Remove a working directory that holds no session we can read.
     *
     * Only ever called from `restore`, which runs before this process has
     * created anything, so a directory without a readable `session.json` at that
     * moment is unreachable: no token resolves to it and no sweep will ever look
     * at it again. It can still hold a part-received upload, so it is named
     * rather than removed quietly.
     */
    private purgeOrphan(name: string, why: string): void {
        this.logger.warn(
            `Removing working directory ${name}: ${why}. Anything it held is gone.`
        );
        this.purge(name);
    }

    private restore(): void {
        if (!existsSync(this.workDir)) return;

        let restored = 0;
        let abandoned = 0;
        let discarded = 0;
        let stranded = 0;
        let orphaned = 0;
        for (const entry of readdirSync(this.workDir, {
            withFileTypes: true,
        })) {
            if (!entry.isDirectory()) continue;
            const path = join(this.workDir, entry.name, 'session.json');
            if (!existsSync(path)) {
                this.purgeOrphan(entry.name, 'it holds no session record');
                orphaned++;
                continue;
            }

            try {
                const session = JSON.parse(
                    readFileSync(path, 'utf-8')
                ) as Session;
                if (!session?.id || !session?.sessionToken) {
                    this.purgeOrphan(
                        entry.name,
                        'its session record is missing an id or token'
                    );
                    orphaned++;
                    continue;
                }

                // A finished session has nothing left to do and nothing left to
                // show: its output is in the customer's bucket and its URL is
                // already back with the CMS. Restoring it only kept the record
                // alive so an age-based sweep could delete it hours later, while
                // whatever remained of its work directory sat on the disk. Boot
                // is the natural moment to be rid of both.
                if (TERMINAL.includes(session.status)) {
                    this.purge(session.id);
                    discarded++;
                    continue;
                }

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
                    this.purgeOutput(session.id);
                    abandoned++;
                }

                // Everything still here is non-terminal, so it has work left
                // that ends at someone's bucket. Without the keys to reach it
                // there is no honest state but failed — and this reason
                // outranks "the encoder restarted", since re-running is not
                // what fixes it.
                if (!this.recoverCredentials(session)) {
                    session.status = 'failed';
                    session.error = CREDENTIALS_LOST;
                    stranded++;
                }

                this.sessions.set(session.id, session);
                this.tokenIndex.set(session.sessionToken, session.id);
                if (session.readToken) {
                    this.readTokenIndex.set(session.readToken, session.id);
                }
                this.persist(session);
                restored++;
            } catch (err) {
                this.purgeOrphan(
                    entry.name,
                    `its session record could not be read (${(err as Error).message})`
                );
                orphaned++;
            }
        }

        if (restored > 0 || discarded > 0 || orphaned > 0) {
            this.logger.log(
                `Restored ${restored} session(s) from disk` +
                    (abandoned > 0
                        ? `, ${abandoned} marked failed after restart`
                        : '') +
                    (stranded > 0
                        ? `, ${stranded} failed for want of their credentials`
                        : '') +
                    (discarded > 0
                        ? `, discarded ${discarded} finished session(s)`
                        : '') +
                    (orphaned > 0
                        ? `, removed ${orphaned} orphaned working director${orphaned === 1 ? 'y' : 'ies'}`
                        : '')
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
            fallbackNote: session.fallbackNote,
            files: session.files,
            masterPlaylist: session.masterPlaylist,
            thumbnailsVtt: session.thumbnailsVtt,
            segmentFormat: session.segmentFormat,
            ingestTotalBytes: session.ingestTotalBytes,
            storyboardThumbCount: session.storyboardThumbCount,
            storyboardComplete: session.storyboardComplete,
            hlsUrl: session.hlsUrl,
            ...extra,
        });
    }

    create(config: CreateSessionDto, init: SessionInit = {}): Session {
        return this.createWith(() => config, init);
    }

    /**
     * Create a session whose config depends on its own id.
     *
     * The CMS gives every session its own subfolder in the bucket, and the
     * folder is named after the session — so the id has to exist before the
     * config does. Handing the builder the id keeps that in one step rather than
     * creating a session and then editing the credentials block underneath it.
     */
    createWith(
        build: (sessionId: string) => CreateSessionDto,
        init: SessionInit = {}
    ): Session {
        const id = randomUUID();
        const sessionToken = `sess_${randomUUID().replace(/-/g, '')}`;

        const session: Session = {
            id,
            sessionToken,
            status: 'created',
            progress: 0,
            config: build(id),
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            ...init,
        };

        // Only a remote caller needs a credential it can hand to a browser: the
        // local UI already holds the instance token. A read token exists so the CMS
        // can watch a session it is not allowed to drive.
        if (init.origin === 'cms') {
            session.readToken = `read_${randomUUID().replace(/-/g, '')}`;
            this.readTokenIndex.set(session.readToken, id);
        }

        this.sessions.set(id, session);
        this.tokenIndex.set(sessionToken, id);
        this.persist(session);
        this.logger.log(`Session created: ${id}`);

        return session;
    }

    get(id: string): Session | undefined {
        return this.sessions.get(id);
    }

    /** Every session this instance knows about, newest first. */
    list(): Session[] {
        return [...this.sessions.values()].sort(
            (a, b) => b.createdAt - a.createdAt
        );
    }

    getBySessionToken(token: string): Session | undefined {
        const id = this.tokenIndex.get(token);
        if (!id) return undefined;
        return this.sessions.get(id);
    }

    /** Resolve the read-only credential handed to the CMS. */
    getByReadToken(token: string): Session | undefined {
        const id = this.readTokenIndex.get(token);
        if (!id) return undefined;
        return this.sessions.get(id);
    }

    /**
     * The session already working on this document, if there is one.
     *
     * A CMS user clicking "upload media" twice — a double click, a reopened tab,
     * a page refresh mid-upload — must land back on the session already in
     * flight rather than start a second one against the same post. Finished
     * sessions are not matched: that click means "replace what is there".
     */
    findActiveByDocumentId(
        documentId: string,
        callerOrigin?: string
    ): Session | undefined {
        return this.list().find(
            (session) =>
                session.documentId === documentId &&
                ACTIVE.includes(session.status) &&
                // Same document is not enough — it has to be the same caller.
                // Document ids are the CMS's own post identifiers and are
                // routinely public, so matching on one alone let any other
                // approved site collect a session's read token by naming it.
                session.createdByOrigin === callerOrigin
        );
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
     * How many source-storyboard thumbnails exist so far.
     *
     * This is what makes the trim filmstrip fill in near-real-time: the client
     * refetches the storyboard VTT when the count grows, rather than guessing
     * on a backoff timer at how far an ffmpeg pass over the whole file has got.
     * Not persisted, for the same reason `updateProgress` is not — it changes
     * constantly and means nothing after a restart.
     *
     * `complete` marks the one report made after the final VTT is written. It
     * cannot ride on the count alone: the last mid-pass report usually already
     * carries the full count, and a repeat of the same number is not a change
     * the client's watcher can see. A later generation pass (a restored
     * session re-priming) clears it again through its own in-progress reports.
     */
    updateStoryboardProgress(
        id: string,
        thumbCount: number,
        complete = false
    ): void {
        const session = this.sessions.get(id);
        if (session) {
            session.storyboardThumbCount = thumbCount;
            session.storyboardComplete = complete || undefined;
            this.emitEvent(session);
        }
    }

    /**
     * Record a sign of life without changing anything else.
     *
     * Nothing on the session moves while gigabytes are arriving. Without this
     * a slow ingest looks identical to an abandoned one and `cleanupAbandoned`
     * would delete it mid-transfer.
     */
    touch(id: string): void {
        const session = this.sessions.get(id);
        if (session) session.lastActivityAt = Date.now();
    }

    updatePipelineProgress(
        id: string,
        pipelineProgress: PipelineProgress
    ): void {
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

    /**
     * Record the key the output will be encrypted with, at the moment it is
     * generated rather than at the moment the encode finishes.
     *
     * The CMS has to store the key alongside the URL, and it must be able to
     * learn both when encoding starts — waiting for completion would mean a
     * player could reach the playlist before anything could decrypt it. The key
     * is not emitted with the session's events; it is served, masked, from
     * GET /api/sessions/:sessionId/key once this has recorded it.
     */
    setEncryptionKey(id: string, encryptionKeyHex: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.encryptionKeyHex = encryptionKeyHex;
            this.persist(session);
        }
    }

    /**
     * Record where the finished output will be playable from, and say so.
     *
     * Known as soon as the destination prefix is settled, which is well before
     * the first segment exists. The CMS saves it against the post immediately —
     * that is the whole point of the handshake — so this emits rather than
     * waiting for the completion event.
     */
    setHlsUrl(id: string, hlsUrl: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.hlsUrl = hlsUrl;
            this.persist(session);
            this.emitEvent(session);
        }
    }

    /**
     * Record that the encode took a different route than the config asked for.
     *
     * Persisted and announced like any other visible change: the note has to
     * outlive the event, because the session it explains is one the user comes
     * back to after it has finished.
     */
    setFallbackNote(id: string, fallbackNote: string): void {
        const session = this.sessions.get(id);
        if (session) {
            session.fallbackNote = fallbackNote;
            this.persist(session);
            this.emitEvent(session);
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
        thumbnailsVtt?: string,
        segmentFormat?: SegmentFormat,
        encryptionKeyHex?: string
    ): void {
        const session = this.sessions.get(id);
        if (session) {
            session.status = 'completed';
            session.progress = 100;
            session.files = files;
            session.masterPlaylist = masterPlaylist;
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

        this.forget(session);
        this.sessions.delete(id);
        this.purge(id);
        this.logger.log(`Session removed: ${id}`);
        return session;
    }

    /** Drop every credential that resolves to this session. */
    private forget(session: Session): void {
        this.tokenIndex.delete(session.sessionToken);
        if (session.readToken) this.readTokenIndex.delete(session.readToken);
    }

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
     *
     * Finished sessions are not this sweep's business: they are discarded at
     * boot instead, so nothing has to guess how long a completed encode is still
     * interesting for.
     */
    cleanupAbandoned(maxAgeMs: number): number {
        const cutoff = Date.now() - maxAgeMs;
        const idle: SessionStatus[] = ['created', 'uploading', 'uploaded'];
        let removed = 0;

        for (const [id, session] of this.sessions.entries()) {
            if (!idle.includes(session.status)) continue;
            if (session.lastActivityAt >= cutoff) continue;

            this.forget(session);
            this.sessions.delete(id);
            this.purge(id);
            // Named individually: this deletes a customer's uploaded media,
            // which should never be something you discover by its absence.
            this.logger.log(
                `Removed abandoned session ${id} (${session.status}, ` +
                    `idle ${Math.round((Date.now() - session.lastActivityAt) / 3_600_000)}h)`
            );
            removed++;
        }

        return removed;
    }
}
