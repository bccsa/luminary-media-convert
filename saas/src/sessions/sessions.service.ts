import {
    Injectable,
    Logger,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
    BadGatewayException,
    OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service.js';
import { S3ConfigsService } from '../s3-configs/s3-configs.service.js';
import { HlsParserService } from './hls-parser.service.js';
import { HlsEditClient, type HlsMutateOperation } from './hls-edit.client.js';
import { S3ClientService } from './s3-client.service.js';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
import { UrlUploadDto } from './dto/url-upload.dto.js';
import { ImportSessionDto } from './dto/import-session.dto.js';
import { MoveSessionFilesDto } from './dto/move-session-files.dto.js';
import { RenameSessionPrefixDto } from './dto/rename-session-prefix.dto.js';
import { SaasSessionResponseDto } from './dto/session-response.dto.js';
import { SessionDocument } from './interfaces/session-document.interface.js';

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface SessionRecord {
    sessionId: string;
    userId: string;
    sessionToken: string;
    s3Config?: SessionDocument['s3Config'];
    s3ConfigId?: string;
    encrypted?: boolean;
}

@Injectable()
export class SessionsService implements OnModuleInit {
    private readonly logger = new Logger(SessionsService.name);
    private readonly sessions = new Map<string, SessionRecord>();
    private readonly s3Concurrency = parseInt(
        process.env.S3_UPLOAD_CONCURRENCY ?? '10',
        10,
    );
    private encodingApiUrl: string;
    private encodingApiMasterKey: string;

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly s3ConfigsService: S3ConfigsService,
        private readonly hlsParserService: HlsParserService,
        private readonly s3ClientService: S3ClientService,
        private readonly hlsEditClient: HlsEditClient,
    ) {}

    onModuleInit() {
        this.encodingApiUrl = process.env.ENCODING_API_URL ?? '';
        this.encodingApiMasterKey = process.env.ENCODING_API_MASTER_KEY ?? '';

        if (!this.encodingApiUrl || !this.encodingApiMasterKey) {
            this.logger.warn(
                'ENCODING_API_URL and/or ENCODING_API_MASTER_KEY not set — session creation will fail',
            );
        }
    }

    getSessionRecord(sessionId: string): SessionRecord | undefined {
        return this.sessions.get(sessionId);
    }

    async createSession(
        userId: string,
        dto: CreateSaasSessionDto,
    ): Promise<SaasSessionResponseDto> {
        // Build webhook config so the Encoding API sends status updates back
        const saasUrl = process.env.SAAS_SERVICE_URL || `http://localhost:${process.env.PORT || 3001}`;
        const webhookSecret = process.env.WEBHOOK_SECRET || '';

        // Canonical from the outset: the prefix recorded here is what the rename
        // and move paths later match keys against, so if it disagrees with the
        // keys the encoder actually wrote, those rewrites mis-target. Normalizing
        // before forwarding keeps the two definitions of "where this went" equal.
        const pathPrefix =
            SessionsService.normalizePrefix(dto.s3?.pathPrefix) || undefined;

        const { s3ConfigId: _, ...encodingApiDto } = dto as any;
        // Strip publicUrl from S3 config — not relevant to the Encoding API
        if (encodingApiDto.s3) {
            const { publicUrl: __, ...s3Rest } = encodingApiDto.s3;
            encodingApiDto.s3 = { ...s3Rest, pathPrefix };
        }
        const payload: Record<string, unknown> = {
            ...encodingApiDto,
            webhook: {
                url: `${saasUrl}/saas/webhooks/encoding`,
                sessionToken: webhookSecret,
            },
        };

        const res = await fetch(`${this.encodingApiUrl}/api/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': this.encodingApiMasterKey,
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            this.logger.error(
                `Encoding API session creation failed (${res.status}): ${body.message ?? JSON.stringify(body)}`,
            );
            throw new BadGatewayException(
                body.message ?? `Encoding API returned ${res.status}`,
            );
        }

        const data = await res.json();

        // Store non-secret S3 config for session history
        const s3Config: SessionDocument['s3Config'] = {
            endPoint: dto.s3.endPoint,
            bucket: dto.s3.bucket,
            pathPrefix,
            port: dto.s3.port,
            useSSL: dto.s3.useSSL,
            publicUrl: dto.s3.publicUrl,
        };

        this.sessions.set(data.sessionId, {
            sessionId: data.sessionId,
            userId,
            sessionToken: data.sessionToken,
            s3Config,
            s3ConfigId: dto.s3ConfigId,
            encrypted: dto.encryption?.enabled === true,
        });

        // Create CouchDB document immediately so the session is visible in history
        const now = new Date().toISOString();
        const sessionDoc: SessionDocument = {
            _id: `session:${data.sessionId}`,
            docType: 'session',
            userId,
            sessionId: data.sessionId,
            status: 'created',
            s3Config,
            s3ConfigId: dto.s3ConfigId,
            encrypted: dto.encryption?.enabled === true || undefined,
            createdAt: now,
            updatedAt: now,
        };
        if (!sessionDoc.encrypted) delete sessionDoc.encrypted;
        await this.databaseService.insert(sessionDoc).catch((err) => {
            this.logger.warn(
                `Failed to create CouchDB doc for session ${data.sessionId}: ${err}`,
            );
        });

        this.logger.log(
            `Session ${data.sessionId} created for user ${userId}`,
        );

        return {
            sessionId: data.sessionId,
            encodingApiUrl: this.encodingApiUrl,
            sessionToken: data.sessionToken,
            maxUploadSize: data.maxUploadSize,
        };
    }

    async startUrlUpload(
        userId: string,
        sessionId: string,
        dto: UrlUploadDto,
    ): Promise<{ sessionId: string; status: 'uploading' }> {
        const record = this.sessions.get(sessionId);
        if (!record) {
            throw new NotFoundException(`Session '${sessionId}' not found`);
        }
        if (record.userId !== userId) {
            throw new ForbiddenException('Not authorized to modify this session');
        }

        const res = await fetch(
            `${this.encodingApiUrl}/api/sessions/${sessionId}/url-upload`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-API-Key': this.encodingApiMasterKey,
                },
                body: JSON.stringify({ url: dto.url, filename: dto.filename }),
            },
        );

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            this.logger.error(
                `Encoding API URL upload failed (${res.status}): ${body.message ?? JSON.stringify(body)}`,
            );
            throw new BadGatewayException(
                body.message ?? `Encoding API returned ${res.status}`,
            );
        }

        return { sessionId, status: 'uploading' };
    }

    async deleteSession(
        userId: string,
        sessionId: string,
        deleteFiles = false,
    ): Promise<void> {
        // Try to get the CouchDB doc first (works for both active and historical)
        let doc: SessionDocument | null = null;
        try {
            doc = await this.databaseService.get<SessionDocument>(
                `session:${sessionId}`,
            );
        } catch {
            // No CouchDB doc — check in-memory
        }

        const record = this.sessions.get(sessionId);

        // Must exist in either CouchDB or memory
        if (!doc && !record) {
            throw new NotFoundException(`Session '${sessionId}' not found`);
        }

        // Ownership check
        const ownerId = doc?.userId ?? record?.userId;
        if (ownerId !== userId) {
            throw new ForbiddenException('Not authorized to delete this session');
        }

        // Delete S3 files if requested. When a path prefix exists, list all
        // objects under that prefix so leftover files from previous sessions
        // sharing the same folder are also cleaned up. Without a prefix,
        // fall back to deleting only the tracked file keys.
        if (deleteFiles && doc?.s3ConfigId) {
            try {
                if (doc.s3Config?.pathPrefix) {
                    const prefix = doc.s3Config.pathPrefix.replace(/\/+$/, '') + '/';
                    const allKeys = await this.s3ClientService.listObjects(
                        userId,
                        doc.s3ConfigId,
                        prefix,
                    );
                    if (allKeys.length > 0) {
                        await this.s3ClientService.deleteObjects(
                            userId,
                            doc.s3ConfigId,
                            allKeys,
                        );
                        this.logger.log(
                            `Deleted ${allKeys.length} S3 object(s) under prefix '${prefix}' for session ${sessionId}`,
                        );
                    }
                } else if (doc.files?.length) {
                    await this.s3ClientService.deleteObjects(
                        userId,
                        doc.s3ConfigId,
                        doc.files,
                    );
                    this.logger.log(
                        `Deleted ${doc.files.length} tracked S3 file(s) for session ${sessionId}`,
                    );
                }
            } catch (err) {
                this.logger.warn(
                    `Failed to delete S3 files for session ${sessionId}: ${(err as Error).message}`,
                );
                // Continue with session deletion even if S3 cleanup fails
            }
        }

        // Always ask the encoder, whether or not this process still holds the
        // session in memory. Gating on the in-memory record meant that after a
        // restart the encoder was never asked at all, and its copy of the source
        // — gigabytes of it — stayed on disk for good.
        //
        // A 404 is fine: the encoder has already forgotten it, which is the
        // state we want. An outright refusal is not — the files are still
        // there, and reporting success would tell the user they had reclaimed
        // space they had not.
        try {
            const res = await fetch(
                `${this.encodingApiUrl}/api/sessions/${sessionId}`,
                {
                    method: 'DELETE',
                    headers: { 'X-API-Key': this.encodingApiMasterKey },
                },
            );

            // A 4xx is the encoder refusing, so the files are certainly still
            // there and the user must hear about it. A 5xx is the encoder
            // broken — transient, and not worth holding the record hostage to.
            if (!res.ok && res.status !== 404 && res.status < 500) {
                const body = await res.json().catch(() => ({}));
                const reason = body.message ?? `status ${res.status}`;
                this.logger.error(
                    `Encoding API refused to delete session ${sessionId}: ${reason}`,
                );
                throw new BadGatewayException(
                    `The encoder could not delete this session (${reason}). ` +
                        'Its files are still on the encoder, so the session has been kept.',
                );
            }
            if (!res.ok && res.status >= 500) {
                this.logger.warn(
                    `Encoding API errored deleting ${sessionId} (${res.status}); its files may remain`,
                );
            }
        } catch (err) {
            if (err instanceof BadGatewayException) throw err;
            // Unreachable rather than refusing. Keeping the record hostage to a
            // service being down helps nobody, so the delete goes ahead.
            this.logger.warn(
                `Encoding API unreachable while deleting ${sessionId}: ${(err as Error).message}`,
            );
        }
        this.sessions.delete(sessionId);

        // Remove CouchDB document
        if (doc?._rev) {
            try {
                await this.databaseService.destroy(doc._id, doc._rev);
            } catch {
                // Ignore — may have been updated concurrently
            }
        }

        this.logger.log(`Session ${sessionId} deleted by user ${userId}`);
    }

    async importSession(
        userId: string,
        dto: ImportSessionDto,
    ): Promise<SessionDocument & { chaptersLanguages?: string[] }> {
        // Resolve S3 config (ownership check included) and decrypt credentials
        // so we can forward them inline to the API's stateless /api/hls/discover.
        const s3Config = await this.s3ConfigsService.getById(
            userId,
            dto.s3ConfigId,
        );
        const { accessKey, secretKey } =
            this.s3ConfigsService.decryptCredentials(s3Config);

        if (!dto.masterPlaylistKey && !dto.folderPrefix) {
            throw new BadRequestException(
                'Either masterPlaylistKey or folderPrefix must be provided',
            );
        }

        // Delegate discovery to the Encoding API. Works identically for
        // SaaS-initiated imports and for standalone API clients that hit
        // /api/hls/discover directly with their own credentials.
        const discovered = await this.hlsEditClient.discover(
            {
                endPoint: s3Config.endPoint,
                port: s3Config.port,
                useSSL: s3Config.useSSL,
                bucket: s3Config.bucket,
                region: s3Config.region,
                accessKey,
                secretKey,
            },
            {
                ...(dto.masterPlaylistKey ? { masterPlaylistKey: dto.masterPlaylistKey } : {}),
                ...(dto.folderPrefix ? { folderPrefix: dto.folderPrefix } : {}),
            },
        );

        const masterPlaylistKey = discovered.masterPlaylistKey;
        const folderPrefix = discovered.folderPrefix;
        const anglePlaylists = discovered.anglePlaylists;

        // List all files under the prefix — still a SaaS concern since we
        // store the file list on the session document for history.
        const files = await this.s3ClientService.listObjects(
            userId,
            dto.s3ConfigId,
            folderPrefix,
        );

        const now = new Date().toISOString();
        const sessionId = randomUUID();

        const doc: SessionDocument = {
            _id: `session:${sessionId}`,
            docType: 'session',
            userId,
            sessionId,
            status: 'completed',
            progress: 100,
            files,
            masterPlaylist: masterPlaylistKey,
            ...(anglePlaylists ? { anglePlaylists } : {}),
            s3Config: {
                endPoint: s3Config.endPoint,
                bucket: s3Config.bucket,
                port: s3Config.port,
                useSSL: s3Config.useSSL,
                publicUrl: s3Config.publicUrl,
            },
            s3ConfigId: dto.s3ConfigId,
            imported: true,
            encrypted: dto.encryptionKey ? true : undefined,
            encryptionKeyHex: dto.encryptionKey ? dto.encryptionKey.toLowerCase() : undefined,
            createdAt: now,
            updatedAt: now,
            completedAt: now,
        };

        // Remove undefined fields
        if (doc.encrypted === undefined) delete doc.encrypted;
        if (doc.encryptionKeyHex === undefined) delete doc.encryptionKeyHex;
        if (!doc.anglePlaylists) delete doc.anglePlaylists;

        await this.databaseService.insert(doc);

        this.logger.log(
            `Session ${sessionId} imported for user ${userId} (${files.length} files, ${anglePlaylists?.length ?? 1} master playlist${anglePlaylists ? 's' : ''})`,
        );

        // chaptersLanguages is transient telemetry for the import view; never
        // persisted to CouchDB (we already inserted `doc` above without it).
        return discovered.chaptersLanguages?.length
            ? { ...doc, chaptersLanguages: discovered.chaptersLanguages }
            : doc;
    }

    // --- CouchDB session history queries ---

    async listSessions(
        userId: string,
        opts: { limit?: number; skip?: number; status?: string; name?: string },
    ): Promise<{ sessions: SessionDocument[]; total: number }> {
        const selector: Record<string, any> = {
            docType: 'session',
            userId,
        };
        if (opts.status) {
            selector.status = opts.status;
        }
        if (opts.name) {
            selector.name = { $regex: `(?i)${escapeRegex(opts.name)}` };
        }

        const limit = opts.limit || 25;
        const skip = opts.skip || 0;

        const [result, countResult] = await Promise.all([
            this.databaseService.find<SessionDocument>({
                selector,
                use_index: opts.status ? 'sessions-by-user-status' : 'sessions-by-user',
                sort: [{ createdAt: 'desc' as const }],
                limit,
                skip,
            }),
            this.databaseService.find<SessionDocument>({
                selector,
                fields: ['_id'],
                limit: 1_000_000,
            }),
        ]);

        return { sessions: result.docs, total: countResult.docs.length };
    }

    async getSession(
        userId: string,
        sessionId: string,
    ): Promise<SessionDocument & { sessionToken?: string; encodingApiUrl?: string }> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to view this session');
        }

        await this.applyLivePublicUrl(userId, doc);

        // Augment with active session data if available in memory
        const record = this.sessions.get(sessionId);
        if (record) {
            return {
                ...doc,
                sessionToken: record.sessionToken,
                encodingApiUrl: this.encodingApiUrl,
            };
        }

        return doc;
    }

    /**
     * Replace the stored `publicUrl` with the storage config's current one.
     *
     * The rest of `s3Config` is deliberately historical — `endPoint`, `bucket`
     * and `pathPrefix` record where the output was actually written, and
     * refreshing them would point old sessions at objects that were never there.
     * `publicUrl` is not a location though, it is how a browser reaches one; when
     * it is corrected, finished sessions have to follow or they stay unplayable
     * with no way to fix them short of encoding again.
     *
     * Falls back to the snapshot if the config has since been deleted or belongs
     * to someone else — a stale URL beats failing the whole session read.
     */
    private async applyLivePublicUrl(
        userId: string,
        doc: SessionDocument,
    ): Promise<void> {
        if (!doc.s3ConfigId || !doc.s3Config) return;
        try {
            const config = await this.s3ConfigsService.getById(
                userId,
                doc.s3ConfigId,
            );
            doc.s3Config.publicUrl = config.publicUrl;
        } catch {
            // Keep the snapshot.
        }
    }

    async updateSessionName(
        userId: string,
        sessionId: string,
        name: string,
    ): Promise<SessionDocument> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to update this session');
        }
        doc.name = name.trim() || undefined;
        doc.updatedAt = new Date().toISOString();
        await this.databaseService.upsert(doc);
        return doc;
    }

    async listAllSessions(
        opts: { limit?: number; skip?: number; status?: string; userId?: string },
    ): Promise<{ sessions: Partial<SessionDocument>[]; total: number }> {
        const selector: Record<string, any> = { docType: 'session' };
        if (opts.status) selector.status = opts.status;
        if (opts.userId) selector.userId = opts.userId;

        const limit = opts.limit || 25;
        const skip = opts.skip || 0;

        const [result, countResult] = await Promise.all([
            this.databaseService.find<SessionDocument>({
                selector,
                use_index: 'sessions-by-created',
                sort: [{ docType: 'desc' as const }, { createdAt: 'desc' as const }],
                limit,
                skip,
            }),
            this.databaseService.find<SessionDocument>({
                selector,
                fields: ['_id'],
                limit: 1_000_000,
            }),
        ]);

        return {
            sessions: result.docs.map((s) => this.stripSensitiveFields(s)),
            total: countResult.docs.length,
        };
    }

    async getSessionAdmin(sessionId: string): Promise<Partial<SessionDocument>> {
        const doc = await this.getSessionDoc(sessionId);
        return this.stripSensitiveFields(doc);
    }

    // -----------------------------------------------------------------------
    // HLS sidecar edits (proxy to Encoding API, mirror results into CouchDB)
    // -----------------------------------------------------------------------

    async hlsRead(userId: string, sessionId: string) {
        const { doc, s3Payload } = await this.resolveForHlsEdit(userId, sessionId);
        if (!doc.masterPlaylist) {
            throw new BadRequestException('Session has no master playlist');
        }
        return this.hlsEditClient.read(s3Payload, doc.masterPlaylist);
    }

    async hlsMutate(
        userId: string,
        sessionId: string,
        ifMatch: string,
        operations: HlsMutateOperation[],
    ): Promise<SessionDocument> {
        const { doc, s3Payload } = await this.resolveForHlsEdit(userId, sessionId);
        if (!doc.masterPlaylist) {
            throw new BadRequestException('Session has no master playlist');
        }

        const result = await this.hlsEditClient.mutate(
            s3Payload,
            doc.masterPlaylist,
            ifMatch,
            operations,
        );

        // Reconcile CouchDB from the post-mutation parsed master.
        // master.m3u8 on S3 remains the source of truth; we just mirror it.
        const now = new Date().toISOString();
        const subtitleMedia = result.master.media.filter((m) => m.type === 'SUBTITLES');
        if (subtitleMedia.length > 0) {
            doc.subtitles = subtitleMedia.map((m) => ({
                language: m.language ?? '',
                name: m.name,
                key: m.uri ? this.joinRelative(doc.masterPlaylist!, m.uri) : '',
                ...(m.default ? { default: true } : {}),
                ...(m.forced ? { forced: true } : {}),
                updatedAt: now,
            }));
        } else if (doc.subtitles) {
            delete doc.subtitles;
        }

        doc.editVersion = (doc.editVersion ?? 0) + 1;
        doc.updatedAt = now;
        await this.databaseService.upsert(doc);

        return doc;
    }

    /**
     * Read the chapter VTT for a session via the Encoding API.
     * Returns null when no file exists.
     */
    async readChapters(
        userId: string,
        sessionId: string,
        lang: string,
    ): Promise<{ vtt: string } | null> {
        const { doc, s3Payload } = await this.resolveForHlsEdit(userId, sessionId);
        const folderPrefix = this.deriveFolderPrefix(doc);
        return this.hlsEditClient.readChapters(s3Payload, folderPrefix, lang);
    }

    /**
     * Read the waveform.json sidecar for a session via the Encoding API.
     * Returns null when the sidecar is missing — caller responds 404 and
     * the client quietly skips waveform rendering.
     */
    async readWaveform(
        userId: string,
        sessionId: string,
    ): Promise<{
        version: number;
        sampleRate: number;
        numPeaks: number;
        peaks: number[];
    } | null> {
        const { doc, s3Payload } = await this.resolveForHlsEdit(userId, sessionId);
        const folderPrefix = this.deriveFolderPrefix(doc);
        return this.hlsEditClient.readWaveform(s3Payload, folderPrefix);
    }

    /**
     * Write the chapter VTT for a session via the Encoding API. The Encoding
     * API enforces VTT and lang validation; we just forward.
     */
    async writeChapters(
        userId: string,
        sessionId: string,
        lang: string,
        vtt: string,
    ): Promise<void> {
        const { doc, s3Payload } = await this.resolveForHlsEdit(userId, sessionId);
        const folderPrefix = this.deriveFolderPrefix(doc);
        await this.hlsEditClient.writeChapters(s3Payload, folderPrefix, lang, vtt);
    }

    /**
     * Best-effort folder prefix for a session.
     * Prefer the master playlist's folder; fall back to the s3 path prefix.
     */
    private deriveFolderPrefix(doc: SessionDocument): string {
        if (doc.masterPlaylist) {
            const lastSlash = doc.masterPlaylist.lastIndexOf('/');
            return lastSlash >= 0 ? doc.masterPlaylist.slice(0, lastSlash + 1) : '';
        }
        if (doc.s3Config?.pathPrefix) {
            return doc.s3Config.pathPrefix.endsWith('/')
                ? doc.s3Config.pathPrefix
                : doc.s3Config.pathPrefix + '/';
        }
        throw new BadRequestException(
            'Session has no folder prefix to read/write chapters under',
        );
    }

    private async resolveForHlsEdit(
        userId: string,
        sessionId: string,
    ): Promise<{ doc: SessionDocument; s3Payload: Parameters<HlsEditClient['read']>[0] }> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to modify this session');
        }
        if (!doc.s3ConfigId) {
            throw new BadRequestException('Session is not linked to an S3 config');
        }

        const s3Config = await this.s3ConfigsService.getById(userId, doc.s3ConfigId);
        const { accessKey, secretKey } = this.s3ConfigsService.decryptCredentials(s3Config);

        const s3Payload = {
            endPoint: s3Config.endPoint,
            port: s3Config.port,
            useSSL: s3Config.useSSL,
            bucket: s3Config.bucket,
            region: s3Config.region,
            accessKey,
            secretKey,
        };

        return { doc, s3Payload };
    }

    /** Join a relative playlist URI against the master's folder. */
    private joinRelative(masterKey: string, uri: string): string {
        if (uri.startsWith('/') || /^https?:\/\//i.test(uri)) return uri;
        const lastSlash = masterKey.lastIndexOf('/');
        const folder = lastSlash >= 0 ? masterKey.slice(0, lastSlash + 1) : '';
        return folder + uri;
    }

    async moveSessionFiles(
        userId: string,
        sessionId: string,
        dto: MoveSessionFilesDto,
    ): Promise<SessionDocument> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to modify this session');
        }
        if (doc.status !== 'completed' && doc.status !== 'imported') {
            throw new BadRequestException('Only completed or imported sessions can be moved');
        }
        if (!doc.files?.length || !doc.s3ConfigId) {
            throw new BadRequestException('Session has no files or S3 config');
        }

        // Verify target config exists and belongs to user
        const targetConfig = await this.s3ConfigsService.getById(userId, dto.targetS3ConfigId);

        const oldPrefix = doc.s3Config?.pathPrefix ?? '';
        // Ensure prefix always ends with '/'
        const newPrefix = dto.newPathPrefix.endsWith('/') ? dto.newPathPrefix : dto.newPathPrefix + '/';

        // Build key mapping: old key → new key
        const keyMap = new Map<string, string>();
        for (const key of doc.files) {
            keyMap.set(key, this.rewriteKey(key, oldPrefix, newPrefix));
        }

        // Transfer all files to destination (parallel with concurrency limit)
        const transferEntries = [...keyMap.entries()];
        await this.runParallel(transferEntries, ([sourceKey, destKey]) =>
            this.s3ClientService.transferObject(
                userId,
                doc.s3ConfigId!,
                sourceKey,
                dto.targetS3ConfigId,
                destKey,
            ),
        );

        // Delete originals from source
        await this.s3ClientService.deleteObjects(userId, doc.s3ConfigId, doc.files);

        // Update session document
        const rewritten = this.rewriteSessionKeys(doc, oldPrefix, newPrefix);
        doc.files = rewritten.files;
        doc.masterPlaylist = rewritten.masterPlaylist;
        doc.anglePlaylists = rewritten.anglePlaylists;
        doc.thumbnailsVtt = rewritten.thumbnailsVtt;
        doc.s3ConfigId = dto.targetS3ConfigId;
        doc.s3Config = {
            endPoint: targetConfig.endPoint,
            bucket: targetConfig.bucket,
            pathPrefix: newPrefix || undefined,
            port: targetConfig.port,
            useSSL: targetConfig.useSSL,
            publicUrl: targetConfig.publicUrl,
        };
        doc.updatedAt = new Date().toISOString();

        await this.databaseService.upsert(doc);

        this.logger.log(
            `Moved ${doc.files.length} file(s) for session ${sessionId} to config ${dto.targetS3ConfigId}`,
        );

        return doc;
    }

    async renameSessionPrefix(
        userId: string,
        sessionId: string,
        dto: RenameSessionPrefixDto,
    ): Promise<SessionDocument> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to modify this session');
        }
        if (doc.status !== 'completed' && doc.status !== 'imported') {
            throw new BadRequestException('Only completed or imported sessions can be renamed');
        }
        if (!doc.files?.length || !doc.s3ConfigId) {
            throw new BadRequestException('Session has no files or S3 config');
        }

        const oldPrefix = doc.s3Config?.pathPrefix ?? '';
        const newPrefix = SessionsService.normalizePrefix(dto.newPathPrefix);

        // A leading slash is not part of the key as S3 addresses it, so "/out/"
        // and "out/" name the same objects. Comparing the two as plain strings
        // let such a rename through to a copy, which the backend then rejected as
        // copying an object onto itself — surfacing as a bare 500. Recognise it
        // here and rewrite the recorded keys to the canonical form instead, which
        // is what a user spelling the prefix without the slash is asking for.
        if (SessionsService.normalizePrefix(oldPrefix) === newPrefix) {
            return this.commitPrefixChange(doc, oldPrefix, newPrefix);
        }

        // Copy all files to new prefix (parallel with concurrency limit)
        await this.runParallel(doc.files, (key) => {
            const newKey = this.rewriteKey(key, oldPrefix, newPrefix);
            if (SessionsService.addressesSameObject(key, newKey)) {
                return Promise.resolve();
            }
            return this.s3ClientService.copyObjectSameBucket(
                userId,
                doc.s3ConfigId!,
                key,
                newKey,
            );
        });

        // Delete originals — but never one that is also the destination, or the
        // rename would delete the file it just kept.
        const supersededKeys = doc.files.filter(
            (key) =>
                !SessionsService.addressesSameObject(
                    key,
                    this.rewriteKey(key, oldPrefix, newPrefix),
                ),
        );
        if (supersededKeys.length) {
            await this.s3ClientService.deleteObjects(
                userId,
                doc.s3ConfigId,
                supersededKeys,
            );
        }

        return this.commitPrefixChange(doc, oldPrefix, newPrefix);
    }

    /** Trailing slash, no leading slash, no doubled separators. */
    private static normalizePrefix(prefix: string | undefined): string {
        const collapsed = (prefix ?? '')
            .replace(/\/{2,}/g, '/')
            .replace(/^\/+/, '');
        if (!collapsed) return '';
        return collapsed.endsWith('/') ? collapsed : `${collapsed}/`;
    }

    /** Two keys naming one stored object — they differ only in leading slashes. */
    private static addressesSameObject(a: string, b: string): boolean {
        return a.replace(/^\/+/, '') === b.replace(/^\/+/, '');
    }

    /** Point the session document at the new prefix and persist it. */
    private async commitPrefixChange(
        doc: SessionDocument,
        oldPrefix: string,
        newPrefix: string,
    ): Promise<SessionDocument> {
        const rewritten = this.rewriteSessionKeys(doc, oldPrefix, newPrefix);
        doc.files = rewritten.files;
        doc.masterPlaylist = rewritten.masterPlaylist;
        doc.anglePlaylists = rewritten.anglePlaylists;
        doc.thumbnailsVtt = rewritten.thumbnailsVtt;
        if (doc.s3Config) {
            doc.s3Config.pathPrefix = newPrefix || undefined;
        }
        doc.updatedAt = new Date().toISOString();

        await this.databaseService.upsert(doc);

        this.logger.log(
            `Renamed prefix for session ${doc.sessionId}: "${oldPrefix}" → "${newPrefix}"`,
        );

        return doc;
    }

    async checkPrefix(
        userId: string,
        s3ConfigId: string,
        prefix: string,
    ): Promise<{ exists: boolean; count: number }> {
        // Verify config belongs to user
        await this.s3ConfigsService.getById(userId, s3ConfigId);

        // Must canonicalize the same way the encoder does, or this looks in a
        // place nothing was ever written to. Keys are stored without a leading
        // separator, so a prefix typed as "/out" would list "/out/", find
        // nothing, and report a reused prefix as empty — silently disarming the
        // overwrite warning this call exists to raise.
        const normalizedPrefix = SessionsService.normalizePrefix(prefix);
        const keys = await this.s3ClientService.listObjects(userId, s3ConfigId, normalizedPrefix);
        return { exists: keys.length > 0, count: keys.length };
    }

    private rewriteKey(key: string, oldPrefix: string, newPrefix: string): string {
        // Stored pathPrefix may or may not carry a trailing slash (s3.service
        // strips trailing slashes before uploading). Normalize to '/' so
        // slicing leaves no leading '/' to concatenate with newPrefix.
        const normalizedOld = oldPrefix && !oldPrefix.endsWith('/') ? oldPrefix + '/' : oldPrefix;
        if (normalizedOld && key.startsWith(normalizedOld)) {
            return newPrefix + key.slice(normalizedOld.length);
        }
        // If no old prefix or key doesn't match, prepend new prefix
        return newPrefix ? newPrefix + key : key;
    }

    private rewriteSessionKeys(
        doc: SessionDocument,
        oldPrefix: string,
        newPrefix: string,
    ): {
        files: string[];
        masterPlaylist?: string;
        anglePlaylists?: Array<{ name: string; key: string }>;
        thumbnailsVtt?: string;
    } {
        const files = (doc.files ?? []).map((k) => this.rewriteKey(k, oldPrefix, newPrefix));
        const masterPlaylist = doc.masterPlaylist
            ? this.rewriteKey(doc.masterPlaylist, oldPrefix, newPrefix)
            : undefined;
        const anglePlaylists = doc.anglePlaylists?.map((ap) => ({
            name: ap.name,
            key: this.rewriteKey(ap.key, oldPrefix, newPrefix),
        }));
        const thumbnailsVtt = doc.thumbnailsVtt
            ? this.rewriteKey(doc.thumbnailsVtt, oldPrefix, newPrefix)
            : undefined;

        return { files, masterPlaylist, anglePlaylists, thumbnailsVtt };
    }

    /** Strip fields containing personal data, file locations, and credentials from admin responses. */
    private stripSensitiveFields(session: SessionDocument): Partial<SessionDocument> {
        const {
            s3Config,
            s3ConfigId,
            files,
            masterPlaylist,
            anglePlaylists,
            thumbnailsVtt,
            probeResult,
            encryptionKeyHex,
            ...safe
        } = session;
        return safe;
    }

    private async runParallel<T>(
        items: T[],
        fn: (item: T) => Promise<void>,
    ): Promise<void> {
        let nextIndex = 0;
        const worker = async () => {
            while (nextIndex < items.length) {
                const i = nextIndex++;
                await fn(items[i]);
            }
        };
        const workers = Array.from(
            { length: Math.min(this.s3Concurrency, items.length) },
            () => worker(),
        );
        await Promise.all(workers);
    }

    private async getSessionDoc(sessionId: string): Promise<SessionDocument> {
        try {
            return await this.databaseService.get<SessionDocument>(
                `session:${sessionId}`,
            );
        } catch (err: any) {
            if (err.statusCode === 404) {
                throw new NotFoundException(`Session '${sessionId}' not found`);
            }
            throw err;
        }
    }
}
