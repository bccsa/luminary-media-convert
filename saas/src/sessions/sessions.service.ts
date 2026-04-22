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
import { normalizeS3Key, deriveAngleName } from '@luminary-media-converter/hls';
import { DatabaseService } from '../database/database.service.js';
import { S3ConfigsService } from '../s3-configs/s3-configs.service.js';
import { HlsParserService } from './hls-parser.service.js';
import { HlsEditClient, type HlsMutateOperation } from './hls-edit.client.js';
import { S3ClientService } from './s3-client.service.js';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
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

        const { s3ConfigId: _, ...encodingApiDto } = dto as any;
        // Strip publicUrl from S3 config — not relevant to the Encoding API
        if (encodingApiDto.s3) {
            const { publicUrl: __, ...s3Rest } = encodingApiDto.s3;
            encodingApiDto.s3 = s3Rest;
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
            pathPrefix: dto.s3.pathPrefix,
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

        // Delete from Encoding API if active
        if (record) {
            try {
                const res = await fetch(
                    `${this.encodingApiUrl}/api/sessions/${sessionId}`,
                    {
                        method: 'DELETE',
                        headers: { 'X-API-Key': this.encodingApiMasterKey },
                    },
                );

                if (!res.ok && res.status !== 404) {
                    const body = await res.json().catch(() => ({}));
                    this.logger.warn(
                        `Encoding API session delete failed (${res.status}): ${body.message ?? ''}`,
                    );
                }
            } catch {
                // Best-effort — encoding API may be unavailable
            }
            this.sessions.delete(sessionId);
        }

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
    ): Promise<SessionDocument> {
        // Resolve S3 config (ownership check included)
        const s3Config = await this.s3ConfigsService.getById(
            userId,
            dto.s3ConfigId,
        );

        // Accept either masterPlaylistKey or folderPrefix; also tolerate a full
        // S3 URL pasted into either field. A value ending in .m3u8 is treated
        // as a master playlist key, anything else as a folder prefix. In both
        // cases we discover every top-level .m3u8 in the enclosing folder.
        const rawInput = dto.masterPlaylistKey ?? dto.folderPrefix;
        if (!rawInput) {
            throw new BadRequestException(
                'Either masterPlaylistKey or folderPrefix must be provided',
            );
        }
        const normalized = normalizeS3Key(rawInput, s3Config.bucket);

        let folderPrefix: string;
        if (normalized.endsWith('.m3u8')) {
            const lastSlash = normalized.lastIndexOf('/');
            folderPrefix = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
        } else {
            folderPrefix = normalized.endsWith('/') ? normalized : normalized + '/';
        }

        const keys = await this.s3ClientService.listObjects(
            userId,
            dto.s3ConfigId,
            folderPrefix,
        );

        const m3u8Keys = keys.filter((k) => k.endsWith('.m3u8')).sort();
        if (m3u8Keys.length === 0) {
            throw new BadRequestException(
                'No HLS playlist found under the given prefix',
            );
        }

        // Only master playlists are imported as angles — identified by
        // presence of #EXT-X-STREAM-INF. Child rendition playlists are
        // referenced from masters and must not be treated as angles.
        const playlists: string[] = [];
        for (const key of m3u8Keys) {
            const buf = await this.s3ClientService.getObject(
                userId,
                dto.s3ConfigId,
                key,
            );
            if (buf.toString('utf-8').includes('#EXT-X-STREAM-INF')) {
                playlists.push(key);
            }
        }

        if (playlists.length === 0) {
            throw new BadRequestException(
                'No HLS master playlist found under the given prefix',
            );
        }

        // Prefer a file named master.m3u8 as the primary playlist
        const primaryIdx = playlists.findIndex((k) =>
            k === 'master.m3u8' || k.endsWith('/master.m3u8'),
        );
        if (primaryIdx > 0) {
            const [primary] = playlists.splice(primaryIdx, 1);
            playlists.unshift(primary);
        }

        const masterPlaylistKey = playlists[0];
        const anglePlaylists: Array<{ name: string; key: string }> | undefined =
            playlists.length > 1
                ? playlists.map((key, i) => ({
                      name: deriveAngleName(key, folderPrefix, i),
                      key,
                  }))
                : undefined;

        // Fetch and parse master playlist (used for validation + log metadata)
        const playlistBuf = await this.s3ClientService.getObject(
            userId,
            dto.s3ConfigId,
            masterPlaylistKey,
        );
        const playlistContent = playlistBuf.toString('utf-8');
        const parsed =
            this.hlsParserService.parseMasterPlaylist(playlistContent);

        // List all files under the prefix
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
            `Session ${sessionId} imported for user ${userId} (${files.length} files, ${parsed.variants.length} variants)`,
        );

        return doc;
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
        // Ensure non-empty prefix always ends with '/'
        const rawPrefix = dto.newPathPrefix;
        const newPrefix = rawPrefix && !rawPrefix.endsWith('/') ? rawPrefix + '/' : rawPrefix;

        if (oldPrefix === newPrefix) {
            return doc;
        }

        // Copy all files to new prefix (parallel with concurrency limit)
        await this.runParallel(doc.files, (key) => {
            const newKey = this.rewriteKey(key, oldPrefix, newPrefix);
            return this.s3ClientService.copyObjectSameBucket(
                userId,
                doc.s3ConfigId!,
                key,
                newKey,
            );
        });

        // Delete originals
        await this.s3ClientService.deleteObjects(userId, doc.s3ConfigId, doc.files);

        // Update session document
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
            `Renamed prefix for session ${sessionId}: "${oldPrefix}" → "${newPrefix}"`,
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

        const normalizedPrefix = prefix && !prefix.endsWith('/') ? prefix + '/' : prefix;
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
